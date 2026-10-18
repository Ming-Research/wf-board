// git's trace2 event log, for tests that ask when a git process ran: which one started while another was running.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type After = { after(fn: () => void | Promise<void>): void };

/** One line of the log. `time` is the absolute time of the event as an ISO string of one fixed width, so strings compare in time order;
 * `t_abs` counts from each process's own start and means nothing across processes. */
export interface TraceEvent { event: string; sid: string; time: string; argv?: string[] }
/** A git process that started: its arguments, when it started and when it exited. */
export interface TracedProcess { argv: string[]; from: string; to: string }

/** Makes every git process this process starts write its events to the file returned, until the test ends. The store runs git with
 * the process's environment, so the board's own git commands are traced too. */
export async function traceGit(t: After): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-trace-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const before = process.env.GIT_TRACE2_EVENT;
  t.after(() => { if (before === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = before; });
  const file = join(dir, "trace2.jsonl");
  process.env.GIT_TRACE2_EVENT = file;
  return file;
}

/** The events written so far. */
export async function readTrace(file: string): Promise<TraceEvent[]> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  return text.split("\n").filter(line => line !== "").map(line => JSON.parse(line) as TraceEvent);
}

/** The processes that started with arguments `wanted` accepts. A process that never exits lasts to the end of the trace (U+FFFF
 * sorts after any time). */
export function processes(events: TraceEvent[], wanted: (argv: string[]) => boolean): TracedProcess[] {
  const ended = (sid: string, from: string) => events.find(e => e.event === "exit" && e.sid === sid && e.time >= from)?.time ?? "￿";
  return events.filter(e => e.event === "start" && e.argv && wanted(e.argv)).map(e => ({ argv: e.argv!, from: e.time, to: ended(e.sid, e.time) }));
}
