import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Store } from "../src/store.ts";
import { netGit, netGitReason } from "../src/net-git.ts";
import { fakeSsh } from "./fake-ssh.ts";

// The board's push to its remote (docs/design.md, Storage). The remote is a bare repository on this machine reached through a fake
// ssh (test/fake-ssh.ts), which can delay a connection or never answer it: what the real network does that a local path cannot.

type After = { after(fn: () => void | Promise<void>): void };
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
const at = "2026-10-16T01:02:03Z";
const item = (n: number) => ({ title: `Item ${n}`, group: "Test", head: "h".repeat(200), plan: [{ id: "accept", text: "Accepted", state: "todo" as const, accept: true as const }], updated: at });
let counter = 0;
const write = (store: Store) => { const n = ++counter; return store.commit({ author: "push-test", message: `Write ${n}`, puts: [{ kind: "item", id: `i${n}`, doc: item(n), expectRev: null }] }); };
/** `promise`, or a failure after `ms`: with the push in the write queue a write never ends, and the test must say so and not hang. */
const within = <T>(promise: Promise<T>, ms: number, what: string) => Promise.race([promise, sleep(ms).then((): never => { throw new Error(`${what} did not end within ${ms} ms`); })]);

/** A board with a bare remote behind the fake ssh. The fake's environment is set for this process while the test runs, since the
 * store runs git with the process's environment. */
async function fixture(t: After) {
  const base = await mkdtemp(join(tmpdir(), "wf-board-push-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const ssh = await fakeSsh(t);
  const remote = join(base, "remote.git");
  await git(base, "init", "-q", "--bare", "-b", "main", remote);
  const dir = join(base, "data");
  await mkdir(dir);
  const store = await Store.open(dir, { init: true, board: { title: "Push test", projects: [{ name: "Test" }] } });
  await git(dir, "remote", "add", "origin", ssh.url(remote));
  const before = Object.fromEntries(Object.keys(ssh.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, ssh.env);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const remoteHead = () => git(remote, "rev-parse", "--verify", "-q", "refs/heads/main").catch(() => "");
  return { base, ssh, remote, dir, store, remoteHead };
}

test("a write made while the push waits on a silent connection is not held by it; killing the push leaves no ssh behind and the next push works", async t => {
  const f = await fixture(t);
  await f.ssh.set("stall", "receive-pack");
  await write(f.store);
  const stop = new AbortController();
  const outcome = f.store.push(stop.signal).then(() => "sent", (error: Error) => error.message);
  await f.ssh.opened();
  const lasted: number[] = [];
  for (let i = 0; i < 3; i++) { const started = performance.now(); await within(write(f.store), 5000, "a write during the push"); lasted.push(performance.now() - started); }
  assert.ok(Math.max(...lasted) < 2000, `the writes took ${lasted.map(Math.round)} ms`);
  assert.equal(await Promise.race([outcome, sleep(0).then(() => "still running")]), "still running", "the push is still waiting");
  stop.abort();
  assert.match(await within(outcome, 5000, "the killed push"), /stopped on request/);
  await f.ssh.gone();
  // The connection comes back: the next push sends everything, the commits written during the stuck one included.
  await f.ssh.clear("stall");
  assert.equal(await f.store.push(), true);
  assert.equal(await f.remoteHead(), f.store.snapshot().head);
});

test("a push opens one connection when the branch is ahead or current, and a second only when the remote refuses it", async t => {
  const f = await fixture(t);
  await write(f.store);
  assert.equal(await f.store.push(), true);
  assert.equal(await f.ssh.connections(), 1, "ahead of the remote");
  assert.equal(await f.store.push(), false);
  assert.equal(await f.ssh.connections(), 2, "current: one more connection and nothing sent");
  // The remote moves on without this clone: its refusal is followed by one fetch, and a remote that is ahead is no error.
  const other = join(f.base, "other");
  await git(f.base, "clone", "-q", f.remote, other);
  await git(other, "-c", "user.name=Other", "-c", "user.email=other@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "Elsewhere");
  await git(other, "push", "-q", "origin", "main");
  assert.equal(await f.store.push(), false);
  assert.equal(await f.ssh.connections(), 4, "refused, then fetched");
  // A remote that has commits this clone lacks, with commits here the remote lacks, is an error.
  await write(f.store);
  await assert.rejects(f.store.push(), /The remote has commits this clone lacks/);
  assert.equal(await f.ssh.connections(), 6);
});

test("two pushes called together are one push", async t => {
  const f = await fixture(t);
  await f.ssh.set("delay", "0.7");
  await write(f.store);
  assert.deepEqual(await Promise.all([f.store.push(), f.store.push()]), [true, true]);
  assert.equal(await f.ssh.connections(), 1);
  assert.equal(await f.store.push(), false, "a push called afterwards is a push of its own");
  assert.equal(await f.ssh.connections(), 2);
});

test("a push sends the head as of its start: a write during it waits for the next push, and does not wait for this one", async t => {
  const f = await fixture(t);
  await f.ssh.set("delay", "1");
  await write(f.store);
  const first = f.store.snapshot().head;
  let sent = false;
  const push = f.store.push().then(result => { sent = true; return result; });
  await f.ssh.opened();
  await within(write(f.store), 5000, "a write during the push");
  assert.equal(sent, false, "the write was made before the push ended");
  const second = f.store.snapshot().head;
  assert.equal(await push, true);
  assert.equal(await f.remoteHead(), first);
  assert.equal(await f.store.unpushed(), 1);
  await f.ssh.clear("delay");
  assert.equal(await f.store.push(), true);
  assert.equal(await f.remoteHead(), second);
});

test("a push that cannot reach the remote is an error with git's complaint, after one connection", async t => {
  const f = await fixture(t);
  await git(f.dir, "remote", "set-url", "origin", f.ssh.url(join(f.base, "nowhere.git")));
  await write(f.store);
  await assert.rejects(f.store.push(), /git push .*(does not appear to be a git repository|Could not read from remote)/);
  assert.equal(await f.ssh.connections(), 1, "a refusal that is not a rejection is not followed by a fetch");
});

test("a git command that outlives its cap is killed with its ssh, and says so", async t => {
  const f = await fixture(t);
  await f.ssh.set("stall");
  const started = performance.now();
  const result = await within(netGit(["ls-remote", "origin"], { cwd: f.dir, capMs: 1000, killGraceMs: 300 }), 10_000, "the command with a cap");
  const lasted = performance.now() - started;
  assert.equal(result.killedBy, "cap");
  assert.ok(lasted >= 900 && lasted < 5000, `ended after ${Math.round(lasted)} ms`);
  assert.equal(netGitReason(result, 1000), "killed by the cap after 1 s");
  await f.ssh.gone();
});

test("a command that ignores SIGTERM is sent SIGKILL after the grace, whole group", async t => {
  const f = await fixture(t);
  await f.ssh.set("stubborn");
  const stop = new AbortController();
  const running = netGit(["ls-remote", "origin"], { cwd: f.dir, signal: stop.signal, killGraceMs: 400 });
  await f.ssh.opened();
  const started = performance.now();
  stop.abort();
  const result = await within(running, 5000, "the killed command");
  const lasted = performance.now() - started;
  assert.equal(result.killedBy, "signal");
  assert.ok(lasted >= 350, `SIGTERM alone did not end it: it ended after ${Math.round(lasted)} ms, the grace being 400`);
  await f.ssh.gone();
});

test("a git command run by netGit never starts git's automatic maintenance, where the same command run plainly does", async t => {
  const f = await fixture(t);
  await write(f.store); await write(f.store);
  assert.equal(await f.store.push(), true);
  // Every loose object is over the threshold; the remote's own receive-pack is kept from starting maintenance in the same trace.
  await git(f.dir, "config", "gc.auto", "1");
  await git(f.remote, "config", "receive.autogc", "false"); await git(f.remote, "config", "gc.auto", "0");
  const trace = join(f.base, "trace.json");
  const started = async (run: (env: NodeJS.ProcessEnv) => Promise<unknown>) => {
    await writeFile(trace, "");
    await run({ ...process.env, GIT_TRACE2_EVENT: trace });
    await sleep(500);
    return (await readFile(trace, "utf8")).split("\n").filter(line => /"argv":\["[^"]*","maintenance","run","--auto"/.test(line)).length;
  };
  const fetch = ["fetch", "--no-tags", "origin", "refs/heads/main"];
  assert.ok(await started(env => exec("git", fetch, { cwd: f.dir, env })) > 0, "control: a plain fetch starts maintenance here");
  assert.equal(await started(env => netGit(fetch, { cwd: f.dir, env })), 0);
});

test("a command given a signal that is already aborted is not started", async t => {
  const f = await fixture(t);
  const result = await netGit(["ls-remote", "origin"], { cwd: f.dir, signal: AbortSignal.abort() });
  assert.equal(result.killedBy, "signal");
  assert.equal(await f.ssh.connections(), 0);
});

// The daemon itself, in a process of its own, with a push that waits on a connection that never answers.
test("the daemon's writes go on while its push waits on a silent connection, and SIGTERM ends the push and the process within 2 seconds", async t => {
  const f = await fixture(t);
  const seeded = { title: "条目", group: "Test", difficulty: 2, plan: [{ id: "accept", accept: true, text: "通过", state: "todo" }], updated: at };
  await f.store.commit({ author: "Test", message: "Seed", puts: [{ kind: "item", id: "x", expectRev: null, doc: seeded }] });
  await f.ssh.set("stall", "receive-pack");
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const daemon = spawn(process.execPath, [join(import.meta.dirname, "../src/main.ts")], { env: { ...process.env, WF_BOARD_DATA: f.dir, WF_BOARD_PORT: String(port), WF_BOARD_FIRST_PUSH_MS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  daemon.stdout.on("data", chunk => { log += chunk; }); daemon.stderr.on("data", chunk => { log += chunk; });
  const exited = once(daemon, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  t.after(() => { if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL"); });
  await f.ssh.opened(1, 20_000);
  // The push is in flight: a write through the daemon is made at once.
  const started = performance.now();
  const response = await within(fetch(url + "/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: "it:x", kind: "comment", text: "written during the push" }) }), 5000, "a write through the daemon");
  assert.equal(response.status, 200);
  assert.ok(performance.now() - started < 2000, `the write took ${Math.round(performance.now() - started)} ms`);
  const stopped = Date.now();
  daemon.kill("SIGTERM");
  const [code, signal] = await within(exited, 10_000, "the daemon after SIGTERM");
  const took = Date.now() - stopped;
  assert.deepEqual([code, signal], [0, null]);
  assert.ok(took < 2000, `it exited ${took} ms after SIGTERM`);
  await f.ssh.gone();
  assert.match(log, /push of \d+ commits stopped by the shutdown after \d+\.\d s/);
});
