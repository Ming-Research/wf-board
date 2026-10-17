// The board's MCP endpoint keeps no session: one process can be replaced by another while an agent's client stays as it is.
// This runs the daemon itself, twice, on one data directory and one port (docs/design.md, section 4, MCP without a session).
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/store.ts";
import { hashToken } from "../src/credentials.ts";

const TOKEN = "wfb_a-token-for-the-test";
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");

test("a client keeps working across a replacement of the daemon process, and a retry of its last write is not written twice", async t => {
  const data = await mkdtemp(join(tmpdir(), "wf-board-stateless-")), config = await mkdtemp(join(tmpdir(), "wf-board-credentials-")), credentials = join(config, "credentials.json");
  t.after(() => Promise.all([data, config].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))));
  // A board with one item, and the architect's credential in a file beside it.
  const seed = await Store.open(data, { init: true, board: { title: "Stateless test", projects: [{ name: "Test" }, { name: "Architect" }] } });
  const item = { title: "条目", group: "Test", difficulty: 2, plan: [{ id: "accept", accept: true, text: "通过", state: "todo" }], updated: "2026-10-11T01:02:03Z" };
  await seed.commit({ author: "Test", message: "Seed", puts: [{ kind: "item", id: "x", expectRev: null, doc: item }] });
  await writeFile(credentials, JSON.stringify({ credentials: [{ session: "架构师", role: "架构师", project: "Architect", roots: [], hash: hashToken(TOKEN) }] }));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;

  const running: ChildProcess[] = [];
  t.after(() => { for (const child of running) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  async function start(): Promise<ChildProcess> {
    const daemon = spawn(process.execPath, [join(import.meta.dirname, "../src/main.ts")], { env: { ...process.env, WF_BOARD_DATA: data, WF_BOARD_PORT: String(port), WF_BOARD_FIRST_PUSH_MS: "600000", WF_BOARD_CREDENTIALS: credentials }, stdio: ["ignore", "pipe", "pipe"] });
    running.push(daemon);
    // The daemon's log is drained, and shown when the test fails.
    let log = "";
    daemon.stdout!.on("data", chunk => { log += chunk; }); daemon.stderr!.on("data", chunk => { log += chunk; });
    for (let waited = 0; ; waited += 100) {
      assert.ok(waited < 15_000, `the daemon did not answer within 15 s; its log:\n${log}`);
      if (await fetch(url + "/health").then(r => r.ok, () => false)) return daemon;
      await sleep(100);
    }
  }
  async function stop(daemon: ChildProcess): Promise<void> {
    const exited = once(daemon, "exit");
    daemon.kill("SIGTERM");
    const [code] = await Promise.race([exited, sleep(10_000).then(() => { throw new Error("the daemon was still running 10 s after SIGTERM"); })]) as [number | null];
    assert.equal(code, 0);
  }

  const first = await start();
  const client = new Client({ name: "Long-lived agent", version: "1" }); client.onerror = () => {};
  t.after(() => client.close().catch(() => {}));
  const transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  await client.connect(transport);
  assert.equal(transport.sessionId, undefined, "the daemon issued no session");
  const written = text(await client.callTool({ name: "append_log", arguments: { id: "x", text: "written before the replacement" } }));
  const commit = /commit ([0-9a-f]{40})/.exec(written)?.[1];
  assert.ok(commit, written);

  await stop(first);
  const second = await start();
  // The same client, with nothing re-established: its next calls go to the new process.
  const read = await client.callTool({ name: "context", arguments: { id: "x" } });
  assert.ok(!read.isError, text(read));
  assert.match(text(read), /written before the replacement/, "the new process holds what the old one committed");
  // The answer to the write above could have been lost with the old process; the client sends it again.
  const retried = await client.callTool({ name: "append_log", arguments: { id: "x", text: "written before the replacement" } });
  assert.ok(!retried.isError, text(retried));
  assert.match(text(retried), /repeated: the same session wrote this same text a moment ago/);
  assert.ok(text(retried).includes(commit!), "and it is answered with the first write's commit");
  const another = await client.callTool({ name: "append_log", arguments: { id: "x", text: "written after the replacement" } });
  assert.ok(!another.isError, text(another));
  const context = text(await client.callTool({ name: "context", arguments: { id: "x" } }));
  assert.equal(context.split("written before the replacement").length - 1, 1, "the retried write is in the log once");
  assert.match(context, /Architect: written after the replacement/, "and the credential, not the call, named the writer");
  await stop(second);
});
