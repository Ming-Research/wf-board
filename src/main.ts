import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./data-dir.ts";
import { Store } from "./store.ts";
import { ops } from "./ops.ts";
import { ownerOps } from "./owner-ops.ts";
import { createHttpServer } from "./http.ts";
import { createMcpServer } from "./mcp.ts";
import { Wake } from "./wake.ts";
import { macNotify } from "./notify.ts";
import { ghSource } from "./github.ts";
import { GithubWatch } from "./watch.ts";

async function main() {
  const port = Number(process.env.WF_BOARD_PORT ?? 7417);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WF_BOARD_PORT must be an integer from 1 to 65535");
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const store = await Store.open(dataDir(repo), { planConversionHead: process.env.WF_BOARD_PLAN_CONVERSION_HEAD });
  const op = ops(store);
  // The pushes to the architect, kept in a file git leaves out so numbers continue across a restart; the owner's notifications go through osascript.
  const wake = new Wake({ file: await store.localFile("state/wake.jsonl"), notify: macNotify() });
  // The look at GitHub every five minutes, kept across restarts: red checks and mergeable PRs go to the architect, a merged PR marks its merge row done.
  const watch = new GithubWatch({ store, ops: op, wake, github: ghSource(), stateFile: await store.localFile("state/github-watch.json") });
  const server = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: join(dirname(fileURLToPath(import.meta.url)), "../web"), wake, watch, createMcp: () => createMcpServer({ store, ops: op, wake }) });
  async function push() { if (await store.unpushed()) await store.push(); }
  const timer = setInterval(() => { void push().catch(console.error); }, 10 * 60_000);
  timer.unref();
  let stopping = false;
  function shutdown() {
    if (stopping) return; stopping = true; clearInterval(timer);
    server.close(error => {
      void (async () => {
        if (error) throw error;
        await store.flushOwner("owner"); await push();
      })().catch(error => { console.error(error); process.exitCode = 1; });
    });
  }
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  server.on("error", error => { console.error(error); process.exitCode = 1; clearInterval(timer); });
  server.listen(port, "127.0.0.1", () => console.info(`wf-board http://127.0.0.1:${port}`));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
