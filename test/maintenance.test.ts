import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Store } from "../src/store.ts";
import type { OpenOptions } from "../src/store.ts";
import { traceGit, readTrace, processes } from "./git-trace.ts";

// The board maintains its data repository itself: a step after a number of commits, a task of its write queue, with git's own
// maintenance off (docs/design.md, Maintenance; item e2e-git-tmp-flake).

type After = { after(fn: () => void | Promise<void>): void };
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
const at = "2026-10-18T01:02:03Z";
const item = (n: number) => ({ title: `Item ${n}`, group: "P", head: `A head ${n}`, plan: [{ id: "accept", text: "Accepted", state: "todo" as const, accept: true as const }], updated: at });
let counter = 0;
const write = (store: Store) => { const n = ++counter; return store.commit({ author: "maintenance-test", message: `Write ${n}`, puts: [{ kind: "item", id: `i${n}`, doc: item(n), expectRev: null }] }); };
/** Ends when the queue is empty: a step queued by an earlier write has ended. */
const drain = (store: Store) => store.flushOwner("maintenance-test");
/** The loose objects the repository holds, as `git count-objects -v` reads them. */
const loose = async (dir: string) => Number((await git(dir, "count-objects", "-v")).match(/^count: (\d+)$/m)![1]);
const STEP = /^maintenance (\d+) commits (\d+) ms (\d+) packs (\d+\.\d) MB$/;

async function board(t: After, every: number, extra: Partial<OpenOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-maintenance-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const lines: string[] = [];
  const store = await Store.open(dir, { init: true, board: { title: "Maintenance" }, maintenance: { every, log: line => lines.push(line) }, ...extra });
  return { dir, store, lines };
}

test("a step is queued after every N commits, and only then; it packs the loose objects and writes the commit-graph", async t => {
  const { dir, store, lines } = await board(t, 3);
  await write(store); await write(store);
  await drain(store);
  assert.equal(lines.length, 0, "two commits are below N");
  assert.ok(await loose(dir) > 0, "the commits are loose objects");
  await write(store);
  await drain(store);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, STEP);
  assert.equal(lines[0]!.split(" ")[1], "3", "the line names the commits the step covered");
  assert.equal(await loose(dir), 0, "the step packed every loose object");
  await stat(join(dir, ".git/objects/info/commit-graphs/commit-graph-chain"));
  await write(store); await write(store);
  await drain(store);
  assert.equal(lines.length, 1, "the count starts again after a step");
  await write(store);
  await drain(store);
  assert.equal(lines.length, 2);
  assert.equal(await git(dir, "fsck", "--strict", "--no-progress").then(() => "ok"), "ok");
  assert.equal(await git(dir, "rev-list", "--count", "HEAD"), String(1 + 6), "no commit was lost: the first of the board and the six writes");
});

test("commits that arrive while a step is queued share it", async t => {
  const { store, lines } = await board(t, 1);
  // Both are queued before the first runs; the step the first one queues comes after the second, and the second queues none.
  await Promise.all([write(store), write(store)]);
  await drain(store);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^maintenance 2 commits /);
});

test("a backlog found when the store opens is maintained before open returns; a smaller one is left", async t => {
  const { dir, store } = await board(t, 1000);
  for (let i = 0; i < 8; i++) await write(store);
  await drain(store);
  const objects = await loose(dir);
  assert.ok(objects >= 8 * 4, `each write leaves about 4 loose objects: ${objects}`);
  const startup: string[] = [], lines: string[] = [];
  const open = (every: number) => Store.open(dir, { maintenance: { every, log: line => lines.push(line) }, startup: (step, _ms, detail) => { if (step === "maintenance") startup.push(detail ?? ""); } });
  await open(1000);
  assert.equal(lines.length, 0, "a backlog below N waits");
  assert.match(startup.pop()!, /below 1000/);
  assert.equal(await loose(dir), objects, "nothing was touched");
  await open(5);
  assert.equal(lines.length, 1, "the step ended before open returned");
  assert.match(startup.pop()!, /^one step for a backlog of \d+ commits$/);
  assert.equal(await loose(dir), 0);
});

test("git starts no maintenance of its own, where the same commit run plainly does", async t => {
  const trace = await traceGit(t);
  const { dir, store, lines } = await board(t, 1000);
  const control = await mkdtemp(join(tmpdir(), "wf-board-maintenance-control-"));
  t.after(() => rm(control, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  // Every loose object is over the threshold: git would start maintenance after a commit.
  for (const repo of [dir, control]) {
    if (repo === control) await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "gc.auto", "1");
  }
  const starts = async (since: number) => processes((await readTrace(trace)).slice(since), argv => argv.includes("maintenance") || argv.includes("gc")).length;
  let seen = (await readTrace(trace)).length;
  await exec("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-q", "-m", "plain"], { cwd: control });
  assert.ok(await starts(seen) > 0, "control: a plain commit starts maintenance here");
  seen = (await readTrace(trace)).length;
  for (let i = 0; i < 3; i++) await write(store);
  await drain(store);
  assert.equal(await starts(seen), 0);
  assert.equal(lines.length, 0, "and the board's own step has not run either (N is 1000)");
});

test("more than 8 packs before a step also merge the small packs", async t => {
  const trace = await traceGit(t);
  const { dir, store, lines } = await board(t, 1);
  const merges = async () => processes(await readTrace(trace), argv => argv.includes("multi-pack-index") && (argv.includes("expire") || argv.includes("repack"))).length;
  for (let i = 0; i < 9; i++) { await write(store); await drain(store); }
  assert.equal(lines.length, 9);
  assert.equal(await merges(), 0, "up to 8 packs, no merge");
  await write(store); await drain(store);
  assert.equal(lines.length, 10);
  assert.ok(await merges() > 0, "the step that finds 9 packs merges");
  assert.equal(await git(dir, "fsck", "--strict", "--no-progress").then(() => "ok"), "ok");
});

test("a step that fails is logged, loses no write, and is tried again after N more commits", async t => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  const { dir, store, lines } = await board(t, 2);
  // pack-objects refuses a window that is not a number, so repack fails; the commits do not read it.
  await git(dir, "config", "pack.window", "not-a-number");
  for (let i = 0; i < 2; i++) await write(store);
  await drain(store);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /^maintenance of 2 commits failed after \d+ ms; the next try is after 2 more commits/);
  assert.equal(lines.length, 0);
  await write(store);
  await drain(store);
  assert.equal(errors.length, 1, "the count started again after the failure");
  await write(store);
  await drain(store);
  assert.equal(errors.length, 2);
  await git(dir, "config", "--unset", "pack.window");
  for (let i = 0; i < 2; i++) await write(store);
  await drain(store);
  assert.equal(lines.length, 1, "the next step works once the cause is gone");
  assert.equal(await git(dir, "rev-list", "--count", "HEAD"), String(1 + 6));
});

test("after stopMaintenance no step is queued, and a step that was queued already does nothing", async t => {
  const trace = await traceGit(t);
  const { dir, store, lines } = await board(t, 1);
  await write(store); await drain(store);
  assert.equal(lines.length, 1, "control: with N = 1 a commit queues a step");
  const objects = await loose(dir);
  // The first write queues a step behind the second, and the stop comes when the first has ended, before the step starts.
  const first = write(store).then(() => store.stopMaintenance());
  const second = write(store);
  await Promise.all([first, second]);
  await drain(store);
  assert.equal(lines.length, 1, "the queued step did nothing");
  for (let i = 0; i < 3; i++) await write(store);
  await drain(store);
  assert.equal(lines.length, 1, "and the writes after the stop queue none");
  assert.ok(await loose(dir) >= objects + 5 * 4, "all five writes stay loose");
  assert.equal(processes(await readTrace(trace), argv => argv.includes("repack")).length, 1, "git ran repack for the first step only");
});
