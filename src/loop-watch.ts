/** A timer due every `intervalMs` that comes `stallMs` or more late says the event loop was held: no request was answered and no
 * git process was waited on in between. A write that was slow in such a stretch was held with it, and the time of its git
 * commands (src/write-trace.ts) is not git's own. */
export class LoopWatch {
  private readonly intervalMs: number;
  private readonly stallMs: number;
  private readonly log: (line: string) => void;
  private last: number;

  constructor(options: { intervalMs?: number; stallMs?: number; log?: (line: string) => void; now: number }) {
    this.intervalMs = options.intervalMs ?? 100;
    this.stallMs = options.stallMs ?? 500;
    this.log = options.log ?? (line => console.warn(line));
    this.last = options.now;
  }

  /** The timer fired at `now` (milliseconds on a monotonic clock). */
  tick(now: number): void {
    const late = now - this.last - this.intervalMs;
    this.last = now;
    if (late >= this.stallMs) this.log(`event loop held for ${Math.round(late)} ms (a timer due every ${this.intervalMs} ms came that late)`);
  }
}

/** Starts the watch; the returned function stops it. The timer keeps nothing alive. */
export function watchLoop(options: { intervalMs?: number; stallMs?: number; log?: (line: string) => void } = {}): () => void {
  const watch = new LoopWatch({ ...options, now: performance.now() });
  const timer = setInterval(() => watch.tick(performance.now()), options.intervalMs ?? 100);
  timer.unref();
  return () => clearInterval(timer);
}
