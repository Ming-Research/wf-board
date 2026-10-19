import { PerformanceObserver } from "node:perf_hooks";
import { loadavg } from "node:os";

/** What the watch reads besides the clock, to tell why the loop was held. Tests give known numbers. */
export interface LoopMeters {
  /** CPU time the process has used so far, in milliseconds (user and system, all its threads). */
  cpuMs(): number;
  /** Time the process has spent in garbage collection so far, in milliseconds. */
  gcMs(): number;
  /** The machine's load average over the last minute. */
  load(): number;
}

/** Time spent in garbage collection so far: the durations of the `gc` entries of the performance timeline. An entry reaches
 * the observer's callback some time after the collection ended, so a reading also takes the ones still waiting for it. */
export class GcTime {
  private total = 0;
  private readonly observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) this.total += entry.duration; });

  constructor() { this.observer.observe({ entryTypes: ["gc"] }); }

  ms(): number {
    for (const entry of this.observer.takeRecords()) this.total += entry.duration;
    return this.total;
  }

  stop(): void { this.observer.disconnect(); }
}

/** The process's meters: its CPU time, `gc`'s time and the machine's load. The sources of CPU time and load are replaceable
 * for the tests, which give known numbers (`cpuUsage` in microseconds as `process.cpuUsage` answers, `loadavg` as `os.loadavg`). */
export function systemMeters(gc: { ms(): number }, sources: { cpuUsage?: () => { user: number; system: number }; loadavg?: () => number[] } = {}): LoopMeters {
  const cpuUsage = sources.cpuUsage ?? (() => process.cpuUsage()), load = sources.loadavg ?? loadavg;
  return {
    cpuMs: () => { const { user, system } = cpuUsage(); return (user + system) / 1000; },
    gcMs: () => gc.ms(),
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
 * CPU counts every thread of the process, so a collection that runs on helper threads can put it over the held time. */
export class LoopWatch {
  private readonly intervalMs: number;
  private readonly stallMs: number;
  private readonly log: (line: string) => void;
  private readonly meters: LoopMeters;
  private readonly settle: (read: () => void) => void;
  private last: number;
  private cpu: number;
  private gc: number;

  /** `settle` runs the reading of a stall: by default in the check phase of the loop's next turn, where the entries of a
   * collection that ran in a callback of that phase have been handed over (they reach the observer only then). */
  constructor(options: { intervalMs?: number; stallMs?: number; log?: (line: string) => void; now: number; meters: LoopMeters; settle?: (read: () => void) => void }) {
    this.intervalMs = options.intervalMs ?? 100;
    this.stallMs = options.stallMs ?? 500;
    this.log = options.log ?? (line => console.warn(line));
    this.meters = options.meters;
    this.settle = options.settle ?? (read => { setImmediate(read); });
    this.last = options.now;
    this.cpu = this.meters.cpuMs();
    this.gc = this.meters.gcMs();
  }

  /** The timer fired at `now` (milliseconds on a monotonic clock). */
  tick(now: number): void {
    const late = now - this.last - this.intervalMs;
    this.last = now;
    if (late < this.stallMs) {
      this.cpu = this.meters.cpuMs();
      this.gc = this.meters.gcMs();
      return;
    }
    this.settle(() => {
      const cpu = this.meters.cpuMs(), gc = this.meters.gcMs();
      this.log(`event loop held for ${Math.round(late)} ms (a timer due every ${this.intervalMs} ms came that late); cpu ${Math.round(cpu - this.cpu)} ms, gc ${Math.round(gc - this.gc)} ms, load ${this.meters.load().toFixed(2)}`);
      this.cpu = cpu;
      this.gc = gc;
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
