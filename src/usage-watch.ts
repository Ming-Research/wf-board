import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Store } from "./store.ts";
import type { Wake } from "./wake.ts";
import type { BillingSource } from "./billing.ts";
import { advanceBooks, usageFigures, usageLine, usagePushes } from "./rules.ts";
import type { OrgBooks, UsageFigures } from "./rules.ts";

/** What the board does with the organization's Actions billing (docs/design.md, Watching Actions usage): it keeps its own account
 * of the month's included minutes used, says so in a line of the timed wake, and tells the architect when the month's use first
 * reaches a level, one day uses a lot, or the included minutes are all used with a budget of 0. How the account is kept and what
 * is told are pure functions in src/rules.ts. */

export interface UsageWatchOptions {
  store: Store; wake: Wake; billing: BillingSource;
  now?: () => number;
  /** The time between two looks; the billing report moves slowly and every session on the account shares GitHub's quota. */
  everyMs?: number;
  /** Where the time of the last look and the account are kept, so a restart neither looks again at once nor starts the account over. */
  stateFile?: string;
}
export interface UsageStatus { polledAt?: string; /** Owners whose last look failed, with why. */ problems: Record<string, string>; figures: UsageFigures[] }

const Books = z.object({ month: z.string(), since: z.string(), entries: z.array(z.object({ day: z.string(), repo: z.string(), seen: z.number(), counted: z.number() })), told: z.array(z.string()) });
const State = z.object({ polledAt: z.string().optional(), books: z.record(z.string(), Books).optional() });

type Result = { figures: UsageFigures } | { problem: string };

/** Looks at the billing on a timer, keeps the account, and tells the architect. */
export class UsageWatch {
  private readonly announced = new Set<string>();
  private readonly books = new Map<string, OrgBooks>();
  /** The last look at each owner that is an organization, in the order the projects name them. */
  private readonly results = new Map<string, Result>();
  private readonly now: () => number;
  private readonly o: UsageWatchOptions;
  private looked?: number;
  private polled = false;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;

  constructor(o: UsageWatchOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    // The pushes told this month are kept in the state file with the account, not read from the wake events, which are kept for
    // days and not for a month. A state file that cannot be read starts the account again from what the first look sees, so a push
    // may be told a second time; it is said in the log and never stops the watch.
    if (o.stateFile) {
      let text: string | undefined;
      try { text = readFileSync(o.stateFile, "utf8"); } catch { console.info("actions usage: no state file; the account and the told pushes start at the first look"); }
      if (text !== undefined) {
        try {
          const state = State.parse(JSON.parse(text));
          const last = Date.parse(state.polledAt ?? "");
          if (Number.isFinite(last)) this.looked = last;
          for (const [org, books] of Object.entries(state.books ?? {})) { this.books.set(org, books); for (const key of books.told) this.announced.add(key); }
        } catch (error) { console.error(`actions usage: state file unreadable (${error instanceof Error ? error.message : String(error)}); the account and the told pushes start again at the first look`); }
      }
    }
  }

  private get every(): number { return this.o.everyMs ?? 30 * 60_000; }
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

  status(): UsageStatus {
    const problems: Record<string, string> = {}, figures: UsageFigures[] = [];
    for (const [owner, result] of this.results) { if ("problem" in result) problems[owner] = result.problem; else figures.push(result.figures); }
    return { ...(this.looked !== undefined ? { polledAt: new Date(this.looked).toISOString() } : {}), problems, figures };
  }

  /** The line the timed wake carries: each organization's figures, or why they could not be read. Never throws. */
  line(): string {
    if (!this.results.size) return this.polled ? "Actions 用量：没有可读的组织（项目的仓库都在个人账户下）" : "Actions 用量还没读到";
    const several = this.results.size > 1;
    return [...this.results].map(([owner, result]) => "problem" in result ? `${several ? `${owner}：` : ""}Actions 用量读不到：${result.problem}` : usageLine(result.figures, several)).join("；");
  }

  private persist(): void {
    if (!this.o.stateFile) return;
    const temporary = this.o.stateFile + ".tmp";
    try {
      mkdirSync(dirname(this.o.stateFile), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ ...(this.looked !== undefined ? { polledAt: new Date(this.looked).toISOString() } : {}), books: Object.fromEntries(this.books) }) + "\n");
      renameSync(temporary, this.o.stateFile);
    } catch (error) { console.error("actions usage state not written", error); }
  }

  /** One look at every owner of a project's repository, then what follows from it. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const at = new Date(this.now()), owners = new Map<string, string>();
      for (const project of this.o.store.snapshot().board.projects) {
        const owner = project.repo?.split("/")[0];
        if (owner && !owners.has(owner.toLowerCase())) owners.set(owner.toLowerCase(), owner);
      }
      this.looked = at.getTime(); this.polled = true;
      this.persist();
      const found: Array<[string, UsageFigures]> = [];
      for (const owner of owners.values()) {
        try {
          const reading = await this.o.billing.read(owner, at);
          if (!reading) { this.results.delete(owner); continue; }
          const before = this.books.get(owner), after = advanceBooks(before, reading);
          if (before?.month !== after.month) console.info(`actions usage ${owner}: the account for ${after.month} starts now, from the repositories' visibility at this look`);
          this.books.set(owner, after); this.persist();
          const figures = usageFigures(after, reading);
          this.results.set(owner, { figures }); found.push([owner, figures]);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          // Said once while it lasts: a look every half hour would fill the log with the same line.
          const earlier = this.results.get(owner);
          if (!earlier || !("problem" in earlier) || earlier.problem !== reason) console.error(`actions usage ${owner}: ${reason}`);
          this.results.set(owner, { problem: reason });
        }
      }
      for (const owner of [...this.results.keys()]) if (!owners.has(owner.toLowerCase())) this.results.delete(owner);
      if (this.stopped) return;
      for (const [owner, figures] of found) {
        for (const push of usagePushes(figures, this.announced)) {
          this.o.wake.push("actions-usage", { ...push.fields });
          this.announced.add(push.key);
          // Recorded at once, so a restart right after does not tell it again.
          this.books.get(owner)?.told.push(push.key); this.persist();
        }
      }
    } catch (error) { console.error("actions usage watch failed", error); }
    finally { this.polling = false; }
  }
}
