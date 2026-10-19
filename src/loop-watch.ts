import { PerformanceObserver } from "node:perf_hooks";
import { loadavg } from "node:os";

/** What the watch reads besides the clock, to tell why the loop was held. Tests give known numbers. */
export interface LoopMeters {
  /** CPU time the process has used so far, in milliseconds (user and system, all its threads). */
  cpuMs(): number;
  /** Time the process spent in garbage collections that began after `from` and up to `to` (milliseconds on the clock of
   * `performance.now()`), in milliseconds. */
  gcMs(from: number, to: number): number;
  /** The machine's load average over the last minute. */
  load(): number;
}

/** The garbage collections of the process, each with the time it began and its length, from the `gc` entries of the performance
 * timeline. An entry reaches the observer's callback some time after the collection ended, so a reading also takes the ones
 * still waiting for it. Collections older than `KEEP_MS` before the newest one are forgotten: a held loop is not asked about
 * a stretch that long. */
export class GcTime {
  static readonly KEEP_MS = 5 * 60_000;
  private entries: { start: number; duration: number }[] = [];
  private readonly keepMs: number;
  private readonly observer = new PerformanceObserver(list => this.add(list.getEntries()));

  constructor(keepMs = GcTime.KEEP_MS) {
    this.keepMs = keepMs;
    this.observer.observe({ entryTypes: ["gc"] });
  }

  private add(entries: readonly { startTime: number; duration: number }[]): void {
    for (const entry of entries) this.entries.push({ start: entry.startTime, duration: entry.duration });
    const newest = this.entries.at(-1);
    if (!newest) return;
    const cutoff = newest.start - this.keepMs;
    let old = 0;
    while (old < this.entries.length && this.entries[old]!.start < cutoff) old++;
    if (old > 0) this.entries.splice(0, old);
  }

  /** The time of the collections that began after `from` and up to `to`. */
  ms(from: number, to: number): number {
    this.add(this.observer.takeRecords());
    let total = 0;
    for (const entry of this.entries) if (entry.start > from && entry.start <= to) total += entry.duration;
    return total;
  }

  stop(): void { this.observer.disconnect(); }
}

/** The process's meters: its CPU time, `gc`'s time and the machine's load. The sources of CPU time and load are replaceable
 * for the tests, which give known numbers (`cpuUsage` in microseconds as `process.cpuUsage` answers, `loadavg` as `os.loadavg`). */
export function systemMeters(gc: { ms(from: number, to: number): number }, sources: { cpuUsage?: () => { user: number; system: number }; loadavg?: () => number[] } = {}): LoopMeters {
  const cpuUsage = sources.cpuUsage ?? (() => process.cpuUsage()), load = sources.loadavg ?? loadavg;
  return {
    cpuMs: () => { const { user, system } = cpuUsage(); return (user + system) / 1000; },
    gcMs: (from, to) => gc.ms(from, to),
    load: () => load()[0]!,
  };
}

/** A timer due every `intervalMs` that comes `stallMs` or more late says the event loop was held: no request was answered and no
 * git process was waited on in between. A write that was slow in such a stretch was held with it, and the time of its git
 * commands (src/write-trace.ts) is not git's own.
 *
 * The line also says why, with the process's CPU time and garbage collection time between the timer's last two firings and
 * the machine's load average: CPU about the held time and little collection is code that did not return; collection about the
 * held time is the collector; CPU far under the held time is a process that was not given the CPU (the machine was busy). The
 * CPU counts every thread of the process, so a collection that runs on helper threads can put it over the held time.
 *
 * The CPU is read when the timer fires and the collections are those that began between the two firings, so each line has the
 * readings of its own stretch also when the loop was held again before the line was told. The telling waits (see `settle`) only
 * for the entries of the collections to arrive, and reads the load then. */
export class LoopWatch {
  private readonly intervalMs: number;
  private readonly stallMs: number;
  private readonly log: (line: string) => void;
  private readonly meters: LoopMeters;
  private readonly settle: (read: () => void) => void;
  private last: number;
  private cpu: number;

  /** `settle` runs the telling of a stall: by default in the check phase of the loop's turn, where the entries of a
   * collection that ran in a callback of that phase have been handed over (they reach the observer only then). */
  constructor(options: { intervalMs?: number; stallMs?: number; log?: (line: string) => void; now: number; meters: LoopMeters; settle?: (read: () => void) => void }) {
    this.intervalMs = options.intervalMs ?? 100;
    this.stallMs = options.stallMs ?? 500;
    this.log = options.log ?? (line => console.warn(line));
    this.meters = options.meters;
    this.settle = options.settle ?? (read => { setImmediate(read); });
    this.last = options.now;
    this.cpu = this.meters.cpuMs();
  }

  /** The timer fired at `now` (milliseconds on a monotonic clock). */
  tick(now: number): void {
    const from = this.last, late = now - from - this.intervalMs, cpuNow = this.meters.cpuMs(), cpu = cpuNow - this.cpu;
    this.last = now;
    this.cpu = cpuNow;
    if (late < this.stallMs) return;
    this.settle(() => {
      const gc = this.meters.gcMs(from, now);
      this.log(`event loop held for ${Math.round(late)} ms (a timer due every ${this.intervalMs} ms came that late); cpu ${Math.round(cpu)} ms, gc ${Math.round(gc)} ms, load ${this.meters.load().toFixed(2)}`);
    });
  }
}

/** Starts the watch; the returned function stops it. The timer keeps nothing alive. */
export function watchLoop(options: { intervalMs?: number; stallMs?: number; log?: (line: string) => void } = {}): () => void {
  const gc = new GcTime();
  const watch = new LoopWatch({ ...options, now: performance.now(), meters: systemMeters(gc) });
  const timer = setInterval(() => watch.tick(performance.now()), options.intervalMs ?? 100);
  timer.unref();
  return () => { clearInterval(timer); gc.stop(); };
}
