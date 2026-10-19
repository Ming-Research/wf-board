import { format } from "node:util";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

const LEVELS = ["debug", "info", "log", "warn", "error"] as const;

/** `text` with `at` before every one of its lines. */
export function stamped(text: string, at: Date): string {
  const time = at.toISOString();
  return text.split("\n").map(line => `${time} ${line}`).join("\n");
}

/** Makes every line the daemon prints carry its time, so the service log tells when a step ended or a failure came. */
export function timestampLogs(target: Console = console, now: () => Date = () => new Date()): void {
  for (const level of LEVELS) {
    const write = target[level].bind(target);
    target[level] = (...args: unknown[]) => write(stamped(format(...args), now()));
  }
}

/** Told how long a step of a start took, in milliseconds, with what the step found. */
export type StartupStep = (step: string, ms: number, detail?: string) => void;

/** A `StartupStep` that prints the step as one line of the service log. */
export function startupLogger(print: (line: string) => void = line => console.info(line)): StartupStep {
  return (step, ms, detail) => print(`startup ${step}: ${Math.round(ms)} ms${detail === undefined ? "" : ` (${detail})`}`);
}

/** A stopwatch whose every call reports the time since the previous call (or its creation) under a step name. */
export function stopwatch(report?: StartupStep): (step: string, detail?: string) => void {
  let from = performance.now();
  return (step, detail) => { const now = performance.now(); report?.(step, now - from, detail); from = now; };
}

/** A full garbage collection, which node gives only to a process started with `--expose-gc`; turning the flag on afterwards gives it to a new context. */
function fullCollection(): () => void {
  setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
}

const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/** What the process holds once the board is open, as the detail of a startup line with the time of the collection: the heap in use
 * after a full collection, so that the garbage of the start is not counted, the resident set, and the options node was started with
 * (the service's V8 flags, so that the line tells whether the service was installed again after they changed). Told to the log once,
 * and what the live verification of the heap and of the memory reads (docs/design.md, section 4, Parsed documents, Memory beyond
 * the heap). */
export function startupMemory(report: StartupStep, sources: { collect?: () => void; heapUsed?: () => number; rss?: () => number; options?: () => string[] } = {}): void {
  const { collect = fullCollection(), heapUsed = () => getHeapStatistics().used_heap_size, rss = () => process.memoryUsage.rss(), options = () => process.execArgv } = sources;
  const from = performance.now();
  collect();
  const ms = performance.now() - from;
  report("memory", ms, `heap ${megabytes(heapUsed())} MB in use after a full collection, rss ${megabytes(rss())} MB, node options ${options().join(" ") || "none"}`);
}
