import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How long the runner may give no heartbeat before the architect is told. A starting value: nothing has measured how often the
 * runner's loop comes round, so it is reopened if the push comes while the runner is there (docs/design.md, section 8, The runner's heartbeat). */
export const RUNNER_SILENT_MS = 10 * 60_000;
/** The file is written at most this often; a heartbeat in between lives in memory only, so a restart loses at most this much. */
const SAVE_EVERY_MS = 60_000;

export interface RunnerHeartbeatOptions {
  /** Called once for each stretch of silence, with the time (ISO) of the last heartbeat and the limit in milliseconds. */
  tell: (lastBeat: string, limitMs: number) => void;
  now?: () => number;
  /** Where the last heartbeat is kept, outside the board's data and out of git, so a restart does not lose it; without it, in memory only. */
  file?: string;
  limitMs?: number;
}

/**
 * Whether the runner, the one resident program that starts the engineers' turns, is still there (docs/design.md, section 8, The
 * runner's heartbeat). The runner calls `report_heartbeat` at every round of its loop and the board keeps the time of the last
 * call. A round of the minute timer (`check`) tells the architect once when the later of that time and this start is more than the
 * limit old; the next heartbeat ends the silence, so a later one is told again. The board watches only this call: it reads no
 * process table and reaches no machine, so a board on another machine watches the runner the same way.
 *
 * It tells only after the first heartbeat ever kept, so a board that runs before the runner has learned to send one is not
 * telling of a runner that never promised it. The start counts as the time of a heartbeat, since the runner could not reach a board
 * that was stopped.
 */
export class RunnerHeartbeat {
  private readonly tell: RunnerHeartbeatOptions["tell"];
  private readonly now: () => number;
  private readonly file?: string;
  private readonly limitMs: number;
  private readonly started: number;
  /** The last heartbeat, or none until one has been kept (here or by the run before, read from the file). */
  private last: number | undefined;
  private saved = -Infinity;
  /** Told for this stretch of silence: cleared by the next heartbeat. */
  private told = false;

  constructor(options: RunnerHeartbeatOptions) {
    this.tell = options.tell;
    this.now = options.now ?? Date.now;
    this.file = options.file;
    this.limitMs = options.limitMs ?? RUNNER_SILENT_MS;
    this.started = this.now();
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8")) as { last?: unknown };
      if (typeof doc.last === "number" && Number.isFinite(doc.last)) this.last = doc.last;
    } catch { /* no file, or not ours: the runner is not watched until its first heartbeat */ }
  }

  /** The runner is there now. Answers the time kept. */
  beat(): string {
    const now = this.now();
    this.last = now; this.told = false;
    if (now - this.saved >= SAVE_EVERY_MS) this.save(now);
    return new Date(now).toISOString();
  }

  /** One round, from the minute timer. */
  check(): void {
    if (this.last === undefined || this.told) return;
    const now = this.now();
    if (now - Math.max(this.last, this.started) < this.limitMs) return;
    this.told = true;
    const lastBeat = new Date(this.last).toISOString();
    console.warn(`runner heartbeat: none since ${lastBeat}, the limit is ${this.limitMs / 60_000} minutes; told the architect`);
    this.tell(lastBeat, this.limitMs);
  }

  private save(at: number): void {
    if (!this.file) return;
    const temporary = this.file + ".tmp";
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ last: at }) + "\n");
      renameSync(temporary, this.file);
      this.saved = at;
    } catch (error) { console.error("runner heartbeat not written", error); }
  }
}
