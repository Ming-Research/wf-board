import { AsyncLocalStorage } from "node:async_hooks";
import { getHeapStatistics } from "node:v8";

const KB = 1024, MB = 1024 * KB;

/** What a request may read of the board's history (docs/design.md, section 4, Request budgets). */
export interface BudgetLimits {
  /** Bytes of history the request may read, before the range it asks about is known. */
  bytes: number;
  /** Bytes it may read more for each commit of that range (`allowRange` adds them). */
  bytesPerCommit: number;
  /** Whole-board conversions: rebuilding an old board in today's format. */
  boards: number;
  /** The most of the heap limit the process's used heap may reach while the request reads history. */
  heapShare: number;
}
/** A page request, a tool call or a timed task. What the numbers stand for is in the design section. */
export const REQUEST_LIMITS: BudgetLimits = { bytes: 64 * MB, bytesPerCommit: 32 * KB, boards: 1, heapShare: 0.75 };
/** The start: it replays every commit after the startup cache, or all of them when there is none (a scan), so it reads
 * more per commit than a request, and it converts no old board. */
export const STARTUP_LIMITS: BudgetLimits = { bytes: 256 * MB, bytesPerCommit: 64 * KB, boards: 0, heapShare: 0.75 };

/** The daemon's own walk of the unread list to the head (src/unread-warm.ts), which describes each commit after the owner's read
 * cursor once, so it reads whole files where a request, after the first walk, reads none. 256 KB a commit is about 2.4 times what a
 * walk of the live board's 12,621 commits read, 107 KB each (before and after versions of the changed item files; docs/design.md,
 * section 4, The unread list across a restart). */
export const WARM_LIMITS: BudgetLimits = { bytes: 256 * MB, bytesPerCommit: 256 * KB, boards: 1, heapShare: 0.75 };

export interface HeapUse { used: number; limit: number }
export type HeapSource = () => HeapUse;
const processHeap: HeapSource = () => {
  const { used_heap_size, heap_size_limit } = getHeapStatistics();
  return { used: used_heap_size, limit: heap_size_limit };
};

/** What ran out: the bytes read, the whole-board conversions, the process heap, or (`none`) there was no budget to read from. */
export type BudgetResource = "bytes" | "boards" | "heap" | "none";
/** Stops one request. It is an ordinary error to the request's caller (a tool answers with it, a page request with 413);
 * the service goes on. */
export class BudgetError extends Error {
  readonly resource: BudgetResource;
  constructor(resource: BudgetResource, message: string) {
    super(message);
    this.name = "BudgetError";
    this.resource = resource;
  }
}

const mb = (bytes: number): string => `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;

/** The account of one request's reads of the board's history. Store keeps it at three places: reading one historical
 * file, converting a whole old board, and reading a git command's output (`Store.readAt`, `comparisonSnapshot`,
 * `gitRead`); each charges here and each looks at the heap. */
export class Budget {
  readonly name: string;
  private readonly limits: BudgetLimits;
  private readonly heap: HeapSource;
  private allowed: number;
  private bytes = 0;
  private boards = 0;

  constructor(name: string, limits: BudgetLimits = REQUEST_LIMITS, heap: HeapSource = processHeap) {
    this.name = name;
    this.limits = limits;
    this.heap = heap;
    this.allowed = limits.bytes;
  }

  /** The request asks about `commits` commits: it may read `bytesPerCommit` more for each. A cost that follows the range
   * is fine; one that follows the length of the whole history is what the budget is there to stop. */
  allowRange(commits: number): void {
    this.allowed += commits * this.limits.bytesPerCommit;
  }

  /** What has been read so far and what may be, for the benchmark and the tests. */
  usage(): { bytes: number; allowed: number; boards: number } {
    return { bytes: this.bytes, allowed: this.allowed, boards: this.boards };
  }

  /** `count` bytes were read from git. */
  readBytes(count: number): void {
    this.bytes += count;
    if (this.bytes > this.allowed) {
      throw this.stopped("bytes", `read ${mb(this.bytes)} of board history, over the ${mb(this.allowed)} one request may read for this range`);
    }
    this.checkHeap();
  }

  /** A whole old board is about to be rebuilt. */
  board(): void {
    this.boards += 1;
    if (this.boards > this.limits.boards) {
      throw this.stopped("boards", `would rebuild ${this.boards} whole old boards, and one request may rebuild ${this.limits.boards} (a comparison that reaches back before the plan format conversion rebuilds one for each commit it starts from)`);
    }
    this.checkHeap();
  }

  /** The last line of defense: bytes read are an estimate, the heap is what the process runs out of. The heap counts garbage
   * not yet collected and what other requests hold, so the line sits at a share of the limit the normal queries stay well below. */
  checkHeap(): void {
    const { used, limit } = this.heap();
    if (used > limit * this.limits.heapShare) {
      throw this.stopped("heap", `the service's heap is at ${mb(used)}, over ${Math.round(this.limits.heapShare * 100)}% of its ${mb(limit)} limit`);
    }
  }

  private stopped(resource: BudgetResource, what: string): BudgetError {
    const message = `History budget exceeded: this ${this.name} ${what}. Narrow the range (a later since, or a group or under filter) and call again.`;
    console.warn(message);
    return new BudgetError(resource, message);
  }
}

const scope = new AsyncLocalStorage<Budget>();
/** The budget of the request the code runs in, if any. */
export const currentBudget = (): Budget | undefined => scope.getStore();
/** Runs `run` and everything it awaits under `budget`. A budget opened inside another one replaces it for the inner work. */
export function withBudget<T>(budget: Budget, run: () => T): T {
  return scope.run(budget, run);
}
/** `Budget.allowRange` on the current budget; nothing without one. */
export function allowRange(commits: number): void {
  scope.getStore()?.allowRange(commits);
}
