import type { PlanRow, PlanStep, Project, Snapshot } from "./model.ts";
import type { Rules } from "./rules.ts";
import type { Store } from "./store.ts";
import type { Ops } from "./ops.ts";
import { knownRepos, references } from "./query.ts";
import type { PrRef } from "./query.ts";
import type { GithubSource, RepoState } from "./github.ts";
import type { Wake } from "./wake.ts";

/** What the board does with GitHub (docs/design.md, Watching GitHub): it finds the PRs the open items name, tells the architect
 * when the main line or such a PR has red checks or a PR can be merged, and marks the merge row of a merged PR done. */

/** A PR as the board names it: `repo` is the configured `Owner/Name` of a project, `number` the PR's number. */
export interface PrId { repo: string; number: number }
const idKey = (p: PrId): string => `${p.repo.toLowerCase()}#${p.number}`;

/** The text of an item's 改动 section: from its `## 改动` heading to the next `##` heading. Subsections (`###`) stay inside. */
export function changesSection(head: string | undefined): string {
  const out: string[] = [];
  let inside = false;
  for (const line of (head ?? "").split("\n")) {
    if (/^##\s+改动\s*$/.test(line)) { inside = true; continue; }
    if (inside && /^##\s/.test(line)) break;
    if (inside) out.push(line);
  }
  return out.join("\n");
}

/** The configured repository a reference names, or none: `Owner/Repo` must match a project's repo, a bare `Repo` exactly one. */
function repoOf(projects: readonly Project[], ref: PrRef): string | undefined {
  const repos = projects.flatMap(p => p.repo ? [p.repo] : []);
  if (ref.owner) return repos.find(repo => repo.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase());
  const named = repos.filter(repo => repo.split("/").pop()!.toLowerCase() === ref.repo.toLowerCase());
  return named.length === 1 ? named[0] : undefined;
}
/** The PRs a text names that belong to a configured repository. */
function pullsIn(s: Snapshot, text: string, repos: Set<string>): PrId[] {
  const out = new Map<string, PrId>();
  for (const ref of references(text, repos).qualified) {
    const repo = repoOf(s.board.projects, ref);
    if (repo) out.set(idKey({ repo, number: ref.number }), { repo, number: ref.number });
  }
  return [...out.values()];
}

export interface Watched { pr: PrId; /** The open items whose 改动 section names it. */ items: string[] }
/** The PRs the open items name in their 改动 section. */
export function watchedPulls(s: Snapshot, r: Rules): Map<string, Watched> {
  const repos = knownRepos(s), out = new Map<string, Watched>();
  for (const [id, item] of Object.entries(s.items)) {
    if (!r.isOpenWork(id)) continue;
    for (const pr of pullsIn(s, changesSection(item.head), repos)) {
      const entry = out.get(idKey(pr)) ?? { pr, items: [] };
      entry.items.push(id); out.set(idKey(pr), entry);
    }
  }
  return out;
}

export interface MergeRow { item: string; step: PlanStep }
/** The merge rows: a step of an open item that is not done or dropped, is no acceptance step, says 合入 and names the PR. */
export function mergeRows(s: Snapshot, r: Rules): Map<string, { pr: PrId; rows: MergeRow[] }> {
  const repos = knownRepos(s), out = new Map<string, { pr: PrId; rows: MergeRow[] }>();
  for (const [id, item] of Object.entries(s.items)) {
    if (!r.isOpenWork(id)) continue;
    for (const row of item.plan) {
      if (!("text" in row) || row.accept || (row.state !== "todo" && row.state !== "doing") || !row.text.includes("合入")) continue;
      for (const pr of pullsIn(s, row.text, repos)) {
        const entry = out.get(idKey(pr)) ?? { pr, rows: [] };
        entry.rows.push({ item: id, step: row }); out.set(idKey(pr), entry);
      }
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

export type PushEvent = "main-red" | "pr-red" | "pr-ready";
export interface Push { event: PushEvent; /** What makes it the same push again: it is sent once per key. */ key: string; fields: Record<string, unknown> }
/** The key of a push, or none for a frame that is not one of these. A main line is told once per commit, a PR once per kind and head commit. */
export function pushKey(event: string, f: Record<string, unknown>): string | undefined {
  if (event === "main-red") return `${event} ${f.repo} ${f.branch} ${f.commit}`;
  if (event === "pr-red" || event === "pr-ready") return `${event} ${f.repo}#${f.number} ${f.commit}`;
  return undefined;
}

/** What to tell the architect now, from what GitHub says: a red main line; a red non-draft PR an open item names; a non-draft PR
 * an open item names whose checks all passed and which can merge, with the open blocking cards of those items and the cards the
 * item's merge row waits on. A draft PR is never told. */
export function decide(s: Snapshot, r: Rules, states: readonly RepoState[]): Push[] {
  const watched = watchedPulls(s, r), merges = mergeRows(s, r), pushes: Push[] = [];
  for (const state of states) {
    const project = s.board.projects.find(p => p.repo?.toLowerCase() === state.repo.toLowerCase())?.name ?? "";
    if (state.main?.checks.state === "failure") {
      const { branch, commit, checks } = state.main;
      pushes.push({ event: "main-red", key: pushKey("main-red", { repo: state.repo, branch, commit })!, fields: { repo: state.repo, project, branch, commit, failed: checks.failed, url: `https://github.com/${state.repo}/commit/${commit}` } });
    }
    for (const pull of state.pulls) {
      const entry = watched.get(idKey({ repo: state.repo, number: pull.number }));
      if (!entry || pull.draft) continue;
      const common = { repo: state.repo, number: pull.number, project, title: pull.title, commit: pull.commit, url: pull.url };
      const item = (id: string) => ({ item: id, title: s.items[id]!.title, project: r.projectOf(id) });
      if (pull.checks.state === "failure") {
        pushes.push({ event: "pr-red", key: pushKey("pr-red", common)!, fields: { ...common, failed: pull.checks.failed, items: entry.items.map(item) } });
      } else if (pull.checks.state === "success" && pull.mergeable === "MERGEABLE") {
        const items = entry.items.map(id => ({
          ...item(id),
          // Open cards that stop work on the item, and the cards its merge row for this PR waits on.
          blocking: r.cardsOf(id).filter(card => r.cardBlocking(card)).map(card => ({ card, question: s.decisions[card]!.question, blocks: s.decisions[card]!.blocks })),
          approval: (merges.get(idKey(entry.pr))?.rows ?? []).filter(row => row.item === id).flatMap(row => cardsBefore(s, id, row.step.id)),
        }));
        pushes.push({ event: "pr-ready", key: pushKey("pr-ready", common)!, fields: { ...common, base: pull.base, items } });
      }
    }
  }
  return pushes;
}

export interface Merged { pr: PrId; row: MergeRow; mergedAt?: string }
/** The merge rows whose PR GitHub reports merged. */
export function mergedRows(s: Snapshot, r: Rules, states: readonly RepoState[]): Merged[] {
  const out: Merged[] = [];
  for (const { pr, rows } of mergeRows(s, r).values()) {
    const merged = states.find(state => state.repo.toLowerCase() === pr.repo.toLowerCase())?.named.find(n => n.number === pr.number && n.state === "MERGED");
    if (merged) for (const row of rows) out.push({ pr, row, mergedAt: merged.mergedAt });
  }
  return out;
}

export interface WatchOptions {
  store: Store; ops: Ops; wake: Wake; github: GithubSource;
  now?: () => number;
  /** The time between two looks at GitHub; every session on the account shares its quota, so not under five minutes in use. */
  everyMs?: number;
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
  private polledAt?: string;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;
  private readonly o: WatchOptions;

  constructor(o: WatchOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.session = o.session ?? "看板";
    // What the kept events already told the architect is not told again, so a restart neither repeats nor forgets a push.
    for (const frame of o.wake.since(0).frames) { const key = pushKey(frame.event, frame); if (key) this.announced.add(key); }
  }

  start(): void {
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, this.o.everyMs ?? 5 * 60_000);
    this.timer.unref();
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  status(): WatchStatus { return { ...(this.polledAt ? { polledAt: this.polledAt } : {}), problems: Object.fromEntries(this.problems) }; }

  private problem(repo: string, message: string | undefined): void {
    if (message === undefined) { this.problems.delete(repo); return; }
    // Said once while it lasts: a look every five minutes would fill the log with the same line.
    if (this.problems.get(repo) !== message) console.error(`github watch ${repo}: ${message}`);
    this.problems.set(repo, message);
  }

  /** One look at every configured repository, then what follows from it. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const { store, github } = this.o, before = store.snapshot(), earlier = store.derived.rules(before, this.now());
      const numbers = new Map<string, number[]>();
      for (const { pr } of mergeRows(before, earlier).values()) numbers.set(pr.repo.toLowerCase(), [...(numbers.get(pr.repo.toLowerCase()) ?? []), pr.number]);
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
      this.polledAt = new Date(this.now()).toISOString();
      // The board may have changed while GitHub answered: decide on what it is now.
      const s = store.snapshot(), r = store.derived.rules(s, this.now());
      for (const push of decide(s, r, states)) {
        if (this.announced.has(push.key)) continue;
        this.o.wake.push(push.event, push.fields);
        this.announced.add(push.key);
      }
      for (const merged of mergedRows(s, r, states)) await this.markMerged(s, merged);
    } catch (error) { console.error("github watch failed", error); }
    finally { this.polling = false; }
  }

  /** Mark one merge row done and say so in the item's log. A write that fails is tried again at the next look, as the row stays open. */
  private async markMerged(s: Snapshot, { pr, row, mergedAt }: Merged): Promise<void> {
    const { ops } = this.o, author = s.items[row.item]!.group;
    try {
      const { doneAt: _done, since: _since, droppedAt: _dropped, waits: _waits, ...input } = row.step;
      await ops.setPlan({ author, session: this.session, id: row.item, row: { ...input, state: "done" } });
      await ops.appendLog({ author, session: this.session, id: row.item, text: `${pr.repo}#${pr.number} 已在 GitHub 合入${mergedAt ? `（${mergedAt}）` : ""}，看板把合入行「${row.step.text.slice(0, 60)}」标成完成。` });
    } catch (error) { console.error(`github watch: marking ${row.item}/${row.step.id} done failed`, error); }
  }
}
