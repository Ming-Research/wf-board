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
import { startupLogger, stopwatch, timestampLogs } from "./log.ts";
import { SlowOps } from "./slow-ops.ts";

async function main() {
  // Every line of the service log carries its time, and the start reports how long each step took.
  timestampLogs();
  const startup = startupLogger(), lap = stopwatch(startup);
  const port = Number(process.env.WF_BOARD_PORT ?? 7417);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WF_BOARD_PORT must be an integer from 1 to 65535");
  // The first push waits after the start: the agents that reconnect after a restart catch up on writes in the first seconds.
  const firstPushMs = Number(process.env.WF_BOARD_FIRST_PUSH_MS ?? 60_000);
  if (!Number.isInteger(firstPushMs) || firstPushMs < 0) throw new Error("WF_BOARD_FIRST_PUSH_MS must be a non-negative integer");
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const store = await Store.open(dataDir(repo), { planConversionHead: process.env.WF_BOARD_PLAN_CONVERSION_HEAD, startup });
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
  const server = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: join(dirname(fileURLToPath(import.meta.url)), "../web"), wake, watch, usage, slow, createMcp: () => createMcpServer({ store, ops: op, wake, slow }) });
  lap("create wake, watch and server");
  server.once("listening", () => startup("listening", process.uptime() * 1000, "since the process started"));
  // A push with its duration in the log. One takes about 3 to 4 seconds (design section 4, Stopping), during which the store's
  // write queue is held (item push-blocks-writes).
  async function push() {
    const commits = await store.unpushed();
    if (!commits) return;
    const started = performance.now(), took = () => `${((performance.now() - started) / 1000).toFixed(1)} s`;
    try {
      const sent = await store.push();
      console.info(`push of ${commits} commits ${sent ? "took" : "found the remote up to date, took"} ${took()}`);
    } catch (error) { console.error(`push of ${commits} commits failed after ${took()}`); throw error; }
  }
  const timer = setInterval(() => { void push().catch(console.error); }, 10 * 60_000);
  timer.unref();
  let firstPush: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  // Stopping must fit in the 5 seconds launchd allows, and a push takes 3 to 4 seconds alone. So the owner's reading state is
  // committed locally and nothing is pushed; the first push after the next start sends what this run left.
  function shutdown() {
    if (stopping) return; stopping = true; clearInterval(timer); clearTimeout(firstPush);
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
