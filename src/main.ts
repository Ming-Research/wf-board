import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./data-dir.ts";
import { Store } from "./store.ts";
import { ops } from "./ops.ts";
import { ownerOps } from "./owner-ops.ts";
import { createHttpServer } from "./http.ts";
import { createMcpServer } from "./mcp.ts";
import { Wake } from "./wake.ts";
import { ghSource } from "./github.ts";
import { GithubWatch } from "./watch.ts";
import { ghBilling } from "./billing.ts";
import { UsageWatch } from "./usage-watch.ts";
import { BackupPush } from "./backup-push.ts";
import { startupLogger, stopwatch, timestampLogs } from "./log.ts";
import { SlowOps } from "./slow-ops.ts";
import { CredentialFile, Credentials, defaultCredentialsPath } from "./credentials.ts";

async function main() {
  // Every line of the service log carries its time, and the start reports how long each step took.
  timestampLogs();
  const startup = startupLogger(), lap = stopwatch(startup);
  const port = Number(process.env.WF_BOARD_PORT ?? 7417);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WF_BOARD_PORT must be an integer from 1 to 65535");
  // The first push waits 60 seconds after the server starts listening. That delay dates from when a push held the write queue
  // and the agents that reconnect after a restart catch up on writes in the first seconds. A push no longer holds the queue, so
  // the reason is gone; the value stays as a provisional choice, since nothing measured favors another (design section 4, Storage).
  const firstPushMs = Number(process.env.WF_BOARD_FIRST_PUSH_MS ?? 60_000);
  if (!Number.isInteger(firstPushMs) || firstPushMs < 0) throw new Error("WF_BOARD_FIRST_PUSH_MS must be a non-negative integer");
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  // A read of history that runs under no budget fails (docs/design.md, section 4, Request budgets).
  const store = await Store.open(dataDir(repo), { planConversionHead: process.env.WF_BOARD_PLAN_CONVERSION_HEAD, startup, requireBudget: true });
  lap("open store");
  const op = ops(store);
  // The pushes to the architect, kept in a file git leaves out so numbers continue across a restart.
  const wake = new Wake({ file: await store.localFile("state/wake.jsonl") });
  // The look at GitHub every five minutes, kept across restarts: red checks and mergeable PRs go to the architect, a merged PR marks its merge row done.
  const watch = new GithubWatch({ store, ops: op, wake, github: ghSource(), stateFile: await store.localFile("state/github-watch.json") });
  // The look at the organization's Actions billing every half hour, kept across restarts: the month's use is a line of the timed wake and goes to the architect at its levels.
  const usage = new UsageWatch({ store, wake, billing: ghBilling(), stateFile: await store.localFile("state/actions-usage.json") });
  // Times every page request and tool call, and tells the architect of those over their limit (docs/design.md, section 4, Time limits).
  const slow = new SlowOps({ wake });
  // The credentials the agents write with: the long-lived ones are read from a file outside the data directory (src/credentials.ts), the dispatch ones from the data.
  const credentials = new Credentials(new CredentialFile(defaultCredentialsPath()));
  const server = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: join(dirname(fileURLToPath(import.meta.url)), "../web"), wake, watch, usage, slow, credentials, createMcp: credential => createMcpServer({ store, ops: op, wake, slow, credential }) });
  lap("create wake, watch and server");
  server.once("listening", () => startup("listening", process.uptime() * 1000, "since the process started"));
  // The pushes of the board's data to its remote, each with its duration in the log. One takes about 4 to 7 seconds and runs beside
  // the writes, not in their queue; when the remote copy stays behind for an hour the architect is told (design section 4, Storage).
  const backup = new BackupPush({ store, wake });
  const push = () => backup.round();
  const timer = setInterval(() => { void push().catch(console.error); }, 10 * 60_000);
  timer.unref();
  let firstPush: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  // Stopping must fit in the 5 seconds launchd allows, and a push takes 4 to 7 seconds. So the owner's reading state is committed
  // locally and nothing is pushed, a push that is running is killed with its ssh, and the first push after the next start sends
  // what this run left.
  function shutdown() {
    if (stopping) return; stopping = true; clearInterval(timer); clearTimeout(firstPush); backup.stop();
    server.close(error => {
      void (async () => {
        if (error) throw error;
        await store.flushOwner("owner");
      })().catch(error => { console.error(error); process.exitCode = 1; });
    });
  }
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  server.on("error", error => { console.error(error); process.exitCode = 1; clearInterval(timer); });
  server.listen(port, "127.0.0.1", () => {
    console.info(`wf-board http://127.0.0.1:${port}`);
    firstPush = setTimeout(() => { void push().catch(console.error); }, firstPushMs);
    firstPush.unref();
  });
}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
