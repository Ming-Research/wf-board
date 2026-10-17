import type { Store } from "./store.ts";
import type { Wake } from "./wake.ts";

/** How long the remote copy may stay behind before the architect is told (docs/design.md, Storage). A push every 10 minutes
 * is tried in that time, so this is a push that keeps failing or stalling, not one slow round. */
export const BACKUP_LAG_MS = 60 * 60_000;

/** The pushes of the board's data to its remote, and the watch on whether the remote copy keeps up. A round pushes when there are
 * commits the remote lacks, logs its duration, and tells the architect once when the copy has been behind for `lagMs`: a stuck
 * push no longer slows a write (src/store.ts, push), so a stuck backup is otherwise silent. */
export class BackupPush {
  private readonly store: Pick<Store, "push" | "unpushed">;
  private readonly wake: Pick<Wake, "push">;
  private readonly now: () => number;
  private readonly lagMs: number;
  private readonly stopping = new AbortController();
  private running = false;
  /** When the remote copy was last known to hold everything this board had: a push that sent or found nothing to send, or a round
   * that found no commit to send. Until the first of those after the start, the start itself, with `confirmed` false. */
  private currentAt: number;
  private confirmed = false;
  private failure: string | undefined;
  /** Told for this stretch of lag: cleared when the copy is current again, so a later lag is told again. */
  private told = false;

  constructor(opts: { store: Pick<Store, "push" | "unpushed">; wake: Pick<Wake, "push">; now?: () => number; lagMs?: number }) {
    this.store = opts.store; this.wake = opts.wake; this.now = opts.now ?? Date.now; this.lagMs = opts.lagMs ?? BACKUP_LAG_MS;
    this.currentAt = this.now();
  }

  /** Ends the push that is running (git and its ssh are killed) and makes later rounds do nothing: for the shutdown. */
  stop(): void { this.stopping.abort(); }

  /** One round. Rejects when the push failed, after the log line; a round that starts while another runs does nothing. */
  async round(): Promise<void> {
    if (this.running || this.stopping.signal.aborted) return;
    this.running = true;
    try {
      const commits = await this.store.unpushed();
      if (!commits) { this.markCurrent(this.now()); return; }
      const started = performance.now(), startedAt = this.now(), took = () => `${((performance.now() - started) / 1000).toFixed(1)} s`;
      try {
        const sent = await this.store.push(this.stopping.signal);
        // What was current at the start of the push is on the remote; commits written during it are not.
        this.markCurrent(startedAt);
        console.info(`push of ${commits} commits ${sent ? "took" : "found the remote up to date, took"} ${took()}`);
      } catch (error) {
        if (this.stopping.signal.aborted) { console.info(`push of ${commits} commits stopped by the shutdown after ${took()}`); return; }
        this.failure = error instanceof Error ? error.message : String(error);
        console.error(`push of ${commits} commits failed after ${took()}`);
        await this.tellIfBehind().catch(console.error);
        throw error;
      }
    } finally { this.running = false; }
  }

  private markCurrent(at: number): void {
    this.currentAt = Math.max(this.currentAt, at); this.confirmed = true; this.failure = undefined; this.told = false;
  }

  private async tellIfBehind(): Promise<void> {
    if (this.told || this.now() - this.currentAt < this.lagMs) return;
    const commits = await this.store.unpushed();
    if (!commits) return;
    this.told = true;
    this.wake.push("backup-behind", { commits, lastSuccess: this.confirmed ? new Date(this.currentAt).toISOString() : null, reason: this.failure ?? null });
  }
}
