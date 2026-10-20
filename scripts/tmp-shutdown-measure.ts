// TEMPORARY (item shutdown-test-contention): repeats the scenario of the daemon test in test/shutdown.test.ts and prints, for each
// run, where the time between SIGTERM and the daemon's exit went. Removed before the pull request is ready.
//   node scripts/tmp-shutdown-measure.ts <runs per lane> <lanes at once>
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/store.ts";

const git = promisify(execFile);
const [runs, lanes] = process.argv.slice(2).map(Number) as [number, number];

async function one(lane: number, n: number) {
  const data = await mkdtemp(join(tmpdir(), "wf-board-daemon-")), remote = await mkdtemp(join(tmpdir(), "wf-board-remote-"));
  try {
    await git("git", ["init", "--bare", "-b", "main", remote]);
    const seed = await Store.open(data, { init: true, board: { title: "Daemon test", projects: [{ name: "Test" }] } });
    const item = { title: "条目", group: "Test", difficulty: 2, plan: [{ id: "accept", accept: true, text: "通过", state: "todo" }], updated: "2026-10-11T01:02:03Z" };
    await seed.commit({ author: "Test", message: "Seed", puts: [{ kind: "item", id: "x", expectRev: null, doc: item }] });
    await git("git", ["-C", data, "remote", "add", "origin", remote]);
    const local = async () => (await git("git", ["-C", data, "rev-parse", "HEAD"])).stdout.trim();
    const pushed = async () => (await git("git", ["-C", remote, "rev-parse", "--verify", "-q", "refs/heads/main"]).catch(() => ({ stdout: "" }))).stdout.trim();
    const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const url = `http://127.0.0.1:${port}`;
    const daemon = spawn(process.execPath, [join(import.meta.dirname, "../src/main.ts")], { env: { ...process.env, WF_BOARD_DATA: data, WF_BOARD_PORT: String(port), WF_BOARD_FIRST_PUSH_MS: "1500" }, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    daemon.stdout.on("data", chunk => { log += chunk; }); daemon.stderr.on("data", chunk => { log += chunk; });
    const exited = once(daemon, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    for (let waited = 0; ; waited += 100) {
      if (waited > 15_000) throw new Error("no answer");
      if (await fetch(url + "/health").then(r => r.ok, () => false)) break;
      await sleep(100);
    }
    const seeded = await local();
    for (let waited = 0; await pushed() !== seeded; waited += 100) { if (waited > 15_000) throw new Error("no push"); await sleep(100); }
    for (let waited = 0; !/Z push of \d+ commits took \d+\.\d s$/m.test(log); waited += 100) { if (waited > 5000) throw new Error("no push line"); await sleep(100); }
    const mcp = new Client({ name: "Agent", version: "1" }); mcp.onerror = () => {};
    await mcp.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    const json = { method: "POST", headers: { "Content-Type": "application/json" } };
    await fetch(url + "/api/notes", { ...json, body: JSON.stringify({ target: "it:x", kind: "comment", text: "written before the stop" }) });
    const written = await local();
    await fetch(url + "/api/read", { ...json, body: JSON.stringify({ through: written }) });
    const mark = log.length;
    const stopped = Date.now();
    daemon.kill("SIGTERM");
    const [code, signal] = await Promise.race([exited, sleep(10_000).then(() => { throw new Error("still running 10 s after SIGTERM"); })]);
    const took = Date.now() - stopped;
    await mcp.close().catch(() => {});
    const stamps = Object.fromEntries([...log.slice(mark).matchAll(/^(\S+Z) shutdown: (.+)$/gm)].map(m => [m[2], Date.parse(m[1]!) - stopped]));
    console.log(`MEASURE lane=${lane} run=${n} took=${took} code=${code} signal=${signal} ${JSON.stringify(stamps)}${took >= 1000 ? "\n" + log.slice(mark) : ""}`);
  } finally {
    await Promise.all([data, remote].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  }
}

await Promise.all(Array.from({ length: lanes }, async (_, lane) => { for (let n = 0; n < runs; n++) await one(lane, n).catch(error => console.log(`MEASURE lane=${lane} run=${n} ERROR ${error}`)); }));
process.exit(0);
