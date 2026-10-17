import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { holderOf } from "./dispatch.ts";
import type { CheckReading } from "./github.ts";
import type { CiSource } from "./ci-source.ts";
import { OpError } from "./ops.ts";
import type { Ops } from "./ops.ts";
import { prKey } from "./query.ts";
import type { Store } from "./store.ts";
import { watchedPulls } from "./watch.ts";
import type { Watched } from "./watch.ts";

/** What the board does so an engineer need not look at GitHub for its checks (docs/design.md, Watching GitHub, The look at the
 * checks): it looks at the pull requests the open items name, every 30 seconds, and when the checks on a pull request's newest
 * commit have all finished, it sends the session holding the item a message that says so. The pull requests are those of
 * `watchedPulls` (src/watch.ts); how the checks are read is `readChecks` (src/github.ts). */

/** What was last seen of one pull request: the commit, and what the finished round of checks on it said when it was told (the
 * result and the names of the checks that failed), null while a round is awaited. */
export interface CiRecord { commit: string; told: string | null }

/** How a finished round reads, so a result that differs from the one told is news even when no look saw the checks unfinished
 * in between (a rerun that ended between two looks). */
const result = (reading: CheckReading): string => reading.state === "success" ? "success" : `failure:${[...reading.failed].sort().join(",")}`;

/** Whether to tell now, and what to remember. A round is told once: it ends when everything on the commit has finished, and
 * another is told when the commit changes, when something is seen unfinished again (a rerun, the full CI a hand starts on the
 * same commit) or when the result differs from the one told. `baseline`: the repository was never looked at before, so a round
 * that is already over is the board's backlog, not news; it is only remembered. */
export function judge(record: CiRecord | undefined, commit: string, reading: CheckReading, baseline: boolean): { next: CiRecord; tell: boolean } {
  // `none` with nothing unfinished is a commit nobody ran checks on (yet), or one with only skipped gates: nothing to tell.
  const finished = !reading.unfinished && (reading.state === "success" || reading.state === "failure");
  if (!finished) return { next: { commit, told: null }, tell: false };
  const next = { commit, told: result(reading) };
  if (record?.commit === commit && record.told === next.told) return { next: record, tell: false };
  if (baseline && !record) return { next, tell: false };
  return { next, tell: true };
}

/** The most characters of a message's text: a message is one line of at most this (`MESSAGE_TEXT_LIMIT` in src/model.ts). */
const TEXT_LIMIT = 150;
/** The words of the message: the pull request, the commit, and the result. The names of the failed checks go in as long as the line holds them. */
export function ciText(repo: string, number: number, commit: string, reading: CheckReading): string {
  const head = `CI 跑完：${repo}#${number} 提交 ${commit.slice(0, 7)} `;
  if (reading.state === "success") return `${head}全部通过`;
  const names = `${head}有失败：${reading.failed.join("、")}`;
  return [...names].length <= TEXT_LIMIT ? names : `${head}有 ${reading.failed.length} 项失败，名字太长写不下`;
}

export interface CiWatchOptions {
  store: Store; ops: Ops; ci: CiSource;
  now?: () => number;
  /** The time between two looks. Short, because a look that finds nothing new costs no quota (304 answers). */
  everyMs?: number;
  /** Where the records are kept, so a restart neither tells a round twice nor loses one. */
  stateFile?: string;
  /** The session the board's messages carry. */
  session?: string;
}
export interface CiWatchStatus { polledAt?: string; /** The requests left in GitHub's hourly quota as its newest answer said. */ remaining?: number; /** Repositories whose last look failed, with why. */ problems: Record<string, string> }

/** The pull requests looked at at once. */
const PARALLEL = 4;

export class CiWatch {
  /** The repositories (lowercase) looked at completely at least once; a pull request first seen in one that is not among them is baseline. */
  private readonly looks = new Set<string>();
  private readonly records = new Map<string, CiRecord>();
  private readonly problems = new Map<string, string>();
  private readonly now: () => number;
  private readonly session: string;
  private readonly o: CiWatchOptions;
  private looked?: number;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;

  constructor(o: CiWatchOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.session = o.session ?? "看板";
    // A state file that cannot be read costs one baseline look (what is finished by then is not told), never the watch.
    if (o.stateFile) {
      try {
        const saved = JSON.parse(readFileSync(o.stateFile, "utf8")) as { looked?: unknown; pulls?: unknown };
        for (const repo of Array.isArray(saved.looked) ? saved.looked : []) if (typeof repo === "string") this.looks.add(repo);
        if (saved.pulls && typeof saved.pulls === "object") {
          for (const [key, value] of Object.entries(saved.pulls)) {
            const record = value as Partial<CiRecord> | null;
            if (record && typeof record.commit === "string" && (record.told === null || typeof record.told === "string")) this.records.set(key, { commit: record.commit, told: record.told });
          }
        }
      } catch { /* no file, or not ours */ }
    }
  }

  private get every(): number { return this.o.everyMs ?? 30_000; }
  start(): void {
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(ms: number): void {
    this.timer = setTimeout(() => { void this.poll().finally(() => { if (!this.stopped) this.schedule(this.every); }); }, ms);
    this.timer.unref();
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  status(): CiWatchStatus {
    const remaining = this.o.ci.remaining();
    return { ...(this.looked !== undefined ? { polledAt: new Date(this.looked).toISOString() } : {}), ...(remaining === undefined ? {} : { remaining }), problems: Object.fromEntries(this.problems) };
  }

  private problem(repo: string, message: string | undefined): void {
    if (message === undefined) { this.problems.delete(repo); return; }
    // Said once while it lasts: a look every 30 seconds would fill the log with the same line.
    if (this.problems.get(repo) !== message) console.error(`ci watch ${repo}: ${message}`);
    this.problems.set(repo, message);
  }
  private persist(): void {
    if (!this.o.stateFile) return;
    const temporary = this.o.stateFile + ".tmp";
    try {
      mkdirSync(dirname(this.o.stateFile), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ looked: [...this.looks], pulls: Object.fromEntries(this.records) }) + "\n");
      renameSync(temporary, this.o.stateFile);
    } catch (error) { console.error("ci watch state not written", error); }
  }

  /** One look at every pull request an open item names, then what follows from it. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const { store } = this.o, before = store.snapshot();
      const watched = watchedPulls(before, store.derived.rules(before, this.now()));
      this.looked = this.now();
      const byRepo = new Map<string, Watched[]>();
      for (const entry of watched.values()) byRepo.set(entry.pr.repo.toLowerCase(), [...byRepo.get(entry.pr.repo.toLowerCase()) ?? [], entry]);
      const kept = new Set<string>();
      for (const [repo, entries] of byRepo) {
        const baseline = !this.looks.has(repo);
        let failure: string | undefined;
        for (let i = 0; i < entries.length && !this.stopped; i += PARALLEL) {
          await Promise.all(entries.slice(i, i + PARALLEL).map(async entry => {
            const key = prKey(entry.pr);
            try { if (await this.look(entry, baseline)) kept.add(key); else this.records.delete(key); }
            catch (error) { kept.add(key); failure ??= error instanceof Error ? error.message : String(error); }
          }));
        }
        this.problem(repo, failure);
        if (failure === undefined && !this.stopped) this.looks.add(repo);
      }
      // A repository none of whose pull requests is named has nothing to fail at: its first look is over too.
      for (const project of before.board.projects) if (project.repo && !byRepo.has(project.repo.toLowerCase())) { this.looks.add(project.repo.toLowerCase()); this.problem(project.repo, undefined); }
      // What is no longer named by an open item, or no longer open, is forgotten, so the file holds only what is looked at.
      for (const key of [...this.records.keys()]) if (!kept.has(key)) this.records.delete(key);
      this.persist();
    } catch (error) { console.error("ci watch failed", error); }
    finally { this.polling = false; }
  }

  /** One pull request. true: it is open and stays watched. */
  private async look(entry: Watched, baseline: boolean): Promise<boolean> {
    const { ci } = this.o, { repo, number } = entry.pr, key = prKey(entry.pr);
    const pull = await ci.pull(repo, number);
    if (!pull?.open) return false;
    const reading = await ci.checks(repo, pull.commit);
    const record = this.records.get(key), { next, tell } = judge(record, pull.commit, reading, baseline);
    this.records.set(key, next);
    if (tell && !await this.tell(entry, pull.commit, reading)) this.records.set(key, { commit: pull.commit, told: null });
    return true;
  }

  /** The message to each session holding an item that names the pull request. false: it could not be written and is tried again at the next look. */
  private async tell(entry: Watched, commit: string, reading: CheckReading): Promise<boolean> {
    const s = this.o.store.snapshot(), { repo, number } = entry.pr, text = ciText(repo, number, commit, reading);
    const holders = new Map<string, string>();
    for (const item of entry.items) { const holder = holderOf(s, item); if (holder !== undefined && !holders.has(holder)) holders.set(holder, item); }
    let again = false;
    for (const [to, item] of holders) {
      try { await this.o.ops.sendMessage({ author: s.items[item]!.group, session: this.session, to, item, text }); }
      catch (error) {
        console.error(`ci watch: message to ${to} about ${repo}#${number} failed`, error);
        // A refusal (the session ended meanwhile, the item is gone) will not pass by itself; a write that failed may.
        if (!(error instanceof OpError)) again = true;
      }
    }
    return !again;
  }
}
