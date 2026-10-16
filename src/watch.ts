import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PlanRow, PlanStep, Snapshot } from "./model.ts";
import { changesSection, mergeRowDone } from "./rules.ts";
import type { Rules } from "./rules.ts";
import type { Store } from "./store.ts";
import type { Ops } from "./ops.ts";
import { knownRepos, mergeRowPulls, prKey, pullsIn } from "./query.ts";
import type { PrId } from "./query.ts";
import type { GithubSource, RepoState } from "./github.ts";
import type { Wake } from "./wake.ts";

/** What the board does with GitHub (docs/design.md, Watching GitHub): it finds the PRs the open items name, tells the architect
 * when the main line or such a PR has red checks or a PR can be merged, and marks the merge row of a merged PR done.
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

/** The cards a merge row waits on, directly or through the rows before it, and whether each has a ruling. */
function cardsBefore(s: Snapshot, itemId: string, rowId: string): Array<{ card: string; question: string; ruled: boolean }> {
  const rows = s.items[itemId]!.plan, byId = new Map(rows.map(row => [row.id, row] as const)), seen = new Set<string>(), cards: PlanRow[] = [];
  const visit = (row: PlanRow, index: number) => {
    const before = row.after === undefined ? rows.slice(Math.max(0, index - 1), index) : row.after.flatMap(key => byId.get(key) ?? []);
    for (const prior of before) {
      if (seen.has(prior.id)) continue;
      seen.add(prior.id);
      if ("card" in prior) cards.push(prior);
      visit(prior, rows.indexOf(prior));
    }
  };
  const index = rows.findIndex(row => row.id === rowId);
  if (index >= 0) visit(rows[index]!, index);
  return cards.flatMap(row => "card" in row && s.decisions[row.card] ? [{ card: row.card, question: s.decisions[row.card]!.question, ruled: s.decisions[row.card]!.status !== "open" }] : []);
}

export type PushEvent = "main-red" | "pr-red" | "pr-ready" | "pr-orphan";
export interface Push { event: PushEvent; /** What makes it the same push again: it is sent once per key. */ key: string; fields: Record<string, unknown> }
/** The key of a push, or none for a frame that is not one of these. A main line is told once per commit, a PR once per kind and head commit. */
export function pushKey(event: string, f: Record<string, unknown>): string | undefined {
  if (event === "main-red") return `${event} ${f.repo} ${f.branch} ${f.commit}`;
  if (event === "pr-red" || event === "pr-ready") return `${event} ${f.repo}#${f.number} ${f.commit}`;
  // Once per pull request: whether an open item names it does not depend on its commit.
  if (event === "pr-orphan") return `${event} ${f.repo}#${f.number}`;
  return undefined;
}

/** What to tell the architect now, from what GitHub says: a red main line; a red non-draft PR an open item names; a non-draft PR
 * an open item names whose checks all passed and which can merge, with the open blocking cards of those items and the cards the
 * item's merge row waits on; an open PR no open item names (drafts too). A draft PR's checks are never told. */
/** How old an open PR must be before it is told as an orphan: the engineer writes its 改动 section right after opening it. */
export const ORPHAN_AFTER_MS = 10 * 60_000;
export function decide(s: Snapshot, r: Rules, states: readonly RepoState[], now = Date.now()): Push[] {
  const watched = watchedPulls(s, r), merges = mergeRows(s, r), pushes: Push[] = [];
  for (const state of states) {
    const project = s.board.projects.find(p => p.repo?.toLowerCase() === state.repo.toLowerCase())?.name ?? "";
    if (state.main?.checks.state === "failure") {
      const { branch, commit, checks } = state.main;
      pushes.push({ event: "main-red", key: pushKey("main-red", { repo: state.repo, branch, commit })!, fields: { repo: state.repo, project, branch, commit, failed: checks.failed, url: `https://github.com/${state.repo}/commit/${commit}` } });
    }
    for (const pull of state.pulls) {
      const key = prKey({ repo: state.repo, number: pull.number }), entry = watched.get(key);
      if (!entry) {
        if (now - Date.parse(pull.createdAt) < ORPHAN_AFTER_MS) continue;
        pushes.push({ event: "pr-orphan", key: pushKey("pr-orphan", { repo: state.repo, number: pull.number })!, fields: { repo: state.repo, number: pull.number, project, title: pull.title, url: pull.url, draft: pull.draft } });
        continue;
      }
      if (pull.draft) continue;
      const common = { repo: state.repo, number: pull.number, project, title: pull.title, commit: pull.commit, url: pull.url };
      const item = (id: string) => ({ item: id, title: s.items[id]!.title, project: r.projectOf(id) });
      if (pull.checks.state === "failure") {
        pushes.push({ event: "pr-red", key: pushKey("pr-red", common)!, fields: { ...common, failed: pull.checks.failed, items: entry.items.map(item) } });
      } else if (pull.checks.state === "success" && pull.mergeable === "MERGEABLE") {
        const items = entry.items.map(id => ({
          ...item(id),
          // Open cards that stop work on the item, and the cards its merge row for this PR waits on.
          blocking: r.cardsOf(id).filter(card => r.cardBlocking(card)).map(card => ({ card, question: s.decisions[card]!.question, blocks: s.decisions[card]!.blocks })),
          approval: merges.filter(row => row.item === id && row.prs.some(p => prKey(p) === key)).flatMap(row => cardsBefore(s, id, row.step.id)),
        }));
        pushes.push({ event: "pr-ready", key: pushKey("pr-ready", common)!, fields: { ...common, base: pull.base, items } });
      }
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

/** Looks at GitHub on a timer and acts on it: pushes to the architect and marks merge rows done. */
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
    // What the kept events already told the architect is not told again, so a restart neither repeats nor forgets a push.
    for (const frame of o.wake.since(0).frames) { const key = pushKey(frame.event, frame); if (key) this.announced.add(key); }
    // A state file that cannot be read costs one early look, never the watch.
    if (o.stateFile) {
      try {
        const last = Date.parse((JSON.parse(readFileSync(o.stateFile, "utf8")) as { polledAt?: string }).polledAt ?? "");
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
    if (!this.o.stateFile) return;
    const temporary = this.o.stateFile + ".tmp";
    try {
      mkdirSync(dirname(this.o.stateFile), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ polledAt: new Date(at).toISOString() }) + "\n");
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
      for (const push of decide(s, r, states, this.now())) {
        if (this.announced.has(push.key)) continue;
        this.o.wake.push(push.event, push.fields);
        this.announced.add(push.key);
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
