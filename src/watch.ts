import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PlanStep, Snapshot } from "./model.ts";
import { changesSection, mergeRowDone } from "./rules.ts";
import type { Rules } from "./rules.ts";
import type { Store } from "./store.ts";
import type { Ops } from "./ops.ts";
import { deliveries, tellFirst } from "./merges.ts";
import { knownRepos, mergeRowPulls, prKey, pullsIn } from "./query.ts";
import type { PrId } from "./query.ts";
import type { GithubSource, RepoState } from "./github.ts";
import type { Wake } from "./wake.ts";

/** What the board does with GitHub (docs/design.md, Watching GitHub): it finds the PRs the open items name, tells the
 * session holding the delivering item (else the architect) when the main line has red checks, and marks the merge row of a
 * merged PR done.
 * What counts as an item's 改动 section and as a merge row is in src/rules.ts and src/query.ts. */

export interface Watched { pr: PrId; /** The open items whose 改动 section names it. */ items: string[] }
/** The PRs the open items name in their 改动 section. */
export function watchedPulls(s: Snapshot, r: Rules): Map<string, Watched> {
  const repos = knownRepos(s), out = new Map<string, Watched>();
  for (const [id, item] of Object.entries(s.items)) {
    if (!r.isOpenWork(id)) continue;
    for (const pr of pullsIn(s, changesSection(item.head), repos)) {
      const entry = out.get(prKey(pr)) ?? { pr, items: [] };
      entry.items.push(id); out.set(prKey(pr), entry);
    }
  }
  return out;
}

/** A merge row of an open item with the PRs that count for it. */
export interface MergeRow { item: string; step: PlanStep; prs: PrId[] }
export function mergeRows(s: Snapshot, r: Rules): MergeRow[] {
  const repos = knownRepos(s), out: MergeRow[] = [];
  for (const [id, item] of Object.entries(s.items)) {
    if (!r.isOpenWork(id)) continue;
    for (const row of item.plan) {
      if (!("text" in row)) continue;
      const prs = mergeRowPulls(s, id, row, repos);
      if (prs.length) out.push({ item: id, step: row, prs });
    }
  }
  return out;
}

export type PushEvent = "main-red";
export interface Push { event: PushEvent; /** What makes it the same push again: it is sent once per key. */ key: string; fields: Record<string, unknown> }
/** The key of a push, or none for a frame that is not one of these. A main line is told once per commit. */
export function pushKey(event: string, f: Record<string, unknown>): string | undefined {
  if (event === "main-red") return `${event} ${f.repo} ${f.branch} ${f.commit}`;
  return undefined;
}

/** What to tell now, from what GitHub says: a red main line, to the session holding the item that delivered its newest commit,
 * else to the architect. The checks of a PR are not told, a red one, a draft or one that can merge: an engineer watches its own
 * (the look at the checks, src/ci-watch.ts), and a PR no item names is found by the patrol. */
export function decide(s: Snapshot, states: readonly RepoState[]): Push[] {
  const pushes: Push[] = [];
  for (const state of states) {
    const project = s.board.projects.find(p => p.repo?.toLowerCase() === state.repo.toLowerCase())?.name ?? "";
    if (state.main?.checks.state === "failure") {
      const { branch, commit, checks, subject } = state.main;
      // The newest commit names the pull request whose merge the red is told of; the session holding its item is the one to fix it.
      const delivery = tellFirst(s, deliveries(s, state.repo, [subject]))[0];
      pushes.push({ event: "main-red", key: pushKey("main-red", { repo: state.repo, branch, commit })!, fields: {
        repo: state.repo, project, branch, commit, failed: checks.failed, url: `https://github.com/${state.repo}/commit/${commit}`,
        item: delivery?.item ?? null, pr: delivery?.pr ?? null,
      } });
    }
  }
  return pushes;
}

export interface Merged { item: string; step: PlanStep; prs: Array<PrId & { mergedAt?: string }> }
/** The merge rows whose every counted PR GitHub reports merged. */
export function mergedRows(s: Snapshot, r: Rules, states: readonly RepoState[]): Merged[] {
  const merged = new Map<string, string | undefined>();
  for (const state of states) for (const pull of state.named) if (pull.state === "MERGED") merged.set(prKey({ repo: state.repo, number: pull.number }), pull.mergedAt);
  const out: Merged[] = [];
  for (const row of mergeRows(s, r)) {
    if (mergeRowDone(row.prs.map(prKey), new Set(merged.keys()))) out.push({ item: row.item, step: row.step, prs: row.prs.map(pr => ({ ...pr, mergedAt: merged.get(prKey(pr)) })) });
  }
  return out;
}

export interface WatchOptions {
  store: Store; ops: Ops; wake: Wake; github: GithubSource;
  now?: () => number;
  /** The time between two looks at GitHub; every session on the account shares its quota, so not under five minutes in use. */
  everyMs?: number;
  /** Where the time of the last look is kept, so a restart waits out the rest of the interval instead of looking at once. */
  stateFile?: string;
  /** The session the board's own writes carry. */
  session?: string;
}
export interface WatchStatus { polledAt?: string; /** Repositories whose last look failed or was cut short, with why. */ problems: Record<string, string> }

/** Looks at GitHub on a timer and acts on it: tells a red main line and marks merge rows done. */
export class GithubWatch {
  private readonly announced = new Set<string>();
  private readonly problems = new Map<string, string>();
  private readonly now: () => number;
  private readonly session: string;
  private readonly o: WatchOptions;
  private looked?: number;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;

  constructor(o: WatchOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.session = o.session ?? "看板";
    // What the kept events already told is not told again, so a restart neither repeats nor forgets a push.
    for (const frame of o.wake.kept()) { const key = pushKey(frame.event, frame); if (key) this.announced.add(key); }
    // A state file that cannot be read costs one early look, never the watch. An older file also holds the repositories looked at and the open PRs of the first look, for the pushes about PRs, which are gone.
    if (o.stateFile) {
      try {
        const saved = JSON.parse(readFileSync(o.stateFile, "utf8")) as { polledAt?: string };
        const last = Date.parse(saved.polledAt ?? "");
        if (Number.isFinite(last)) this.looked = last;
      } catch { /* no file, or not ours */ }
    }
  }

  private get every(): number { return this.o.everyMs ?? 5 * 60_000; }
  /** How long until the next look is due: at once when none is known, else what is left of the interval since the last. */
  nextDelayMs(): number {
    if (this.looked === undefined) return 0;
    return Math.min(this.every, Math.max(0, this.looked + this.every - this.now()));
  }
  start(): void {
    this.stopped = false;
    this.schedule(this.nextDelayMs());
  }
  private schedule(ms: number): void {
    this.timer = setTimeout(() => { void this.poll().finally(() => { if (!this.stopped) this.schedule(this.every); }); }, ms);
    this.timer.unref();
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  status(): WatchStatus { return { ...(this.looked !== undefined ? { polledAt: new Date(this.looked).toISOString() } : {}), problems: Object.fromEntries(this.problems) }; }

  private problem(repo: string, message: string | undefined): void {
    if (message === undefined) { this.problems.delete(repo); return; }
    // Said once while it lasts: a look every five minutes would fill the log with the same line.
    if (this.problems.get(repo) !== message) console.error(`github watch ${repo}: ${message}`);
    this.problems.set(repo, message);
  }
  private remember(at: number): void {
    this.looked = at;
    this.persist();
  }
  private persist(): void {
    if (!this.o.stateFile) return;
    const temporary = this.o.stateFile + ".tmp";
    try {
      mkdirSync(dirname(this.o.stateFile), { recursive: true });
      writeFileSync(temporary, JSON.stringify(this.looked !== undefined ? { polledAt: new Date(this.looked).toISOString() } : {}) + "\n");
      renameSync(temporary, this.o.stateFile);
    } catch (error) { console.error("github watch state not written", error); }
  }

  /** One look at every configured repository, then what follows from it. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const { store, github } = this.o, before = store.snapshot(), earlier = store.derived.rules(before, this.now());
      const numbers = new Map<string, number[]>();
      for (const { prs } of mergeRows(before, earlier)) for (const pr of prs) {
        const known = numbers.get(pr.repo.toLowerCase()) ?? [];
        if (!known.includes(pr.number)) numbers.set(pr.repo.toLowerCase(), [...known, pr.number]);
      }
      this.remember(this.now());
      const states: RepoState[] = [], looked = new Set<string>();
      for (const project of before.board.projects) {
        // Two projects may share a repository; it is looked at once.
        if (!project.repo || looked.has(project.repo.toLowerCase())) continue;
        looked.add(project.repo.toLowerCase());
        try {
          const state = await github.query(project.repo, { ...(project.mainline ? { branch: project.mainline } : {}), numbers: numbers.get(project.repo.toLowerCase()) ?? [] });
          states.push(state);
          this.problem(project.repo, state.truncated ? "more open PRs than one look reads; the oldest are not watched" : project.mainline && !state.main ? `main line branch ${project.mainline} not found` : undefined);
        } catch (error) { this.problem(project.repo, error instanceof Error ? error.message : String(error)); }
      }
      if (this.stopped) return;
      // The board may have changed while GitHub answered: decide on what it is now.
      const s = store.snapshot(), r = store.derived.rules(s, this.now());
      for (const push of decide(s, states)) {
        if (this.announced.has(push.key)) continue;
        this.announced.add(push.key);
        this.o.wake.push(push.event, push.fields);
      }
      for (const merged of mergedRows(s, r, states)) await this.markMerged(s, merged);
    } catch (error) { console.error("github watch failed", error); }
    finally { this.polling = false; }
  }

  /** Mark one merge row done and say so in the item's log, in one write that checks the row as it is by then. A write that fails is tried again at the next look, as the row stays open. */
  private async markMerged(s: Snapshot, { item, step, prs }: Merged): Promise<void> {
    const named = prs.map(pr => `${pr.repo}#${pr.number}${pr.mergedAt ? `（${pr.mergedAt}）` : ""}`).join("、");
    try {
      await this.o.ops.markMerged({
        author: s.items[item]!.group, session: this.session, id: item, row: step.id, merged: prs.map(({ repo, number }) => ({ repo, number })),
        log: `${named} 已在 GitHub 合入，看板把合入行「${step.text.slice(0, 60)}」标成完成。`,
      });
    } catch (error) { console.error(`github watch: marking ${item}/${step.id} done failed`, error); }
  }
}
