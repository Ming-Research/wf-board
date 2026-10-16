import { format } from "node:util";

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
