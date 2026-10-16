import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** How the owner is told something: a title and a short message, shown where the owner is looking. */
export type Notify = (title: string, message: string) => void | Promise<void>;

/** The script osascript runs. The title and message arrive as its arguments, never spliced into the script text, so quotes,
 * backslashes and newlines in a card's question cannot end the string or add a statement. */
export const NOTIFY_SCRIPT = ["on run argv", 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', "end run"];
/** osascript's argument list for one notification. `--` ends its option parsing, so a message that starts with "-" is an argument. */
export const notifyArgs = (title: string, message: string): string[] => [...NOTIFY_SCRIPT.flatMap(line => ["-e", line]), "--", title, message.slice(0, 240)];

/** A macOS notification through osascript. The daemon runs as a LaunchAgent in the owner's login session, which is what lets it
 * show one. A failed run is tried again; after the last attempt the error goes to the log. */
export function macNotify(options: { command?: string; attempts?: number; retryMs?: number; timeoutMs?: number } = {}): (title: string, message: string) => Promise<void> {
  const { command = "osascript", attempts = 3, retryMs = 5000, timeoutMs = 10_000 } = options;
  const run = (title: string, message: string) => new Promise<void>((resolve, reject) => {
    execFile(command, notifyArgs(title, message), { timeout: timeoutMs }, error => error ? reject(error) : resolve());
  });
  return async (title, message) => {
    let failure: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { await run(title, message); return; }
      catch (error) { failure = error; if (attempt < attempts) await sleep(retryMs); }
    }
    throw failure;
  };
}
