import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { createHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SlowOps, STEPS_FROM_MS } from "../src/slow-ops.ts";
import { WriteTrace, currentTrace, withTrace } from "../src/write-trace.ts";
import { board, author } from "./helpers.ts";

// Where the time of a slow write went (docs/design.md, section 4, Time limits): the steps of a write call. The stalls of the
// event loop that make a git command's time not git's own are told by the watch tested in test/loop-watch.test.ts.

/** Runs `fn` with the service log captured on info and warn. */
async function logged<T>(fn: () => Promise<T> | T): Promise<{ result: T; info: string[]; warn: string[] }> {
  const info: string[] = [], warn: string[] = [];
  const { info: i, warn: w } = console;
  console.info = (...parts: unknown[]) => { info.push(parts.join(" ")); };
  console.warn = (...parts: unknown[]) => { warn.push(parts.join(" ")); };
  try { return { result: await fn(), info, warn }; } finally { console.info = i; console.warn = w; }
}
/** A clock the test moves. */
function clock() {
  const time = { now: 1000 };
  return { time, read: () => time.now };
}
/** The milliseconds a step of a trace line took, or none when the line has no such step. */
const stepMs = (line: string, name: string): number | undefined => {
  const match = new RegExp(`(?:^|, )${name} (\\d+) ms`).exec(line);
  return match ? Number(match[1]) : undefined;
};
/** The names of the steps of a trace line, in order. */
const stepNames = (line: string): string[] => line.split(/ \d+ ms(?: \([^)]*\))?(?:, |$)/).filter(Boolean);
/** Makes every `git commit` in the data directory take `seconds`, the way a slow disk would: a hook git runs before it commits. */
async function slowCommits(dir: string, seconds: number): Promise<void> {
  const hook = join(dir, ".git/hooks/pre-commit");
  await writeFile(hook, `#!/bin/sh\nsleep ${seconds}\n`);
  await chmod(hook, 0o755);
}
const put = (n: number) => ({ kind: "item" as const, id: `trace-${n}`, expectRev: null, doc: { title: `Item ${n}`, group: "P", head: "A head", plan: [{ id: "accept", text: "Accepted", state: "todo" as const, accept: true as const }], updated: "2026-10-18T01:02:03Z" } });

test("a trace is the steps in the order they ran, each with the time since the one before it ended, and rest at the end", () => {
  const { time, read } = clock();
  const trace = new WriteTrace(read);
  time.now += 12.4; trace.lap("ops queue");
  time.now += 300; trace.lap("check");
  time.now += 0.4; trace.lap("files");
  time.now += 2000.6; trace.lap("store queue", "2 ahead, behind write");
  time.now += 30;
  assert.equal(trace.finish(), "ops queue 12 ms, check 300 ms, store queue 2001 ms (2 ahead, behind write), rest 30 ms", "a step under a millisecond is left out, and the steps add up to the call");
});

test("a trace nobody added a step to has only the rest", () => {
  const { time, read } = clock();
  const trace = new WriteTrace(read);
  time.now += 80;
  assert.equal(trace.finish(), "rest 80 ms");
});

test("the trace of a call follows the code it runs, and a task made for no call hides it", async () => {
  const trace = new WriteTrace();
  assert.equal(currentTrace(), undefined);
  await withTrace(trace, async () => {
    await sleep(1);
    assert.equal(currentTrace(), trace, "after an await, still the call's");
    await withTrace(undefined, async () => { await sleep(1); assert.equal(currentTrace(), undefined); });
    assert.equal(currentTrace(), trace);
  });
});

test("a log line carries where the time went from the limit STEPS_FROM_MS on, and the steps are asked for no sooner", async () => {
  assert.equal(STEPS_FROM_MS, 500);
  const slow = new SlowOps();
  let asked = 0;
  const { info } = await logged(() => {
    slow.record({ name: "tool set_plan", cls: "write", ms: STEPS_FROM_MS - 1, result: "ok", steps: () => { asked++; return "git commit 400 ms"; } });
    slow.record({ name: "tool set_plan", cls: "write", ms: STEPS_FROM_MS, result: "ok", steps: () => { asked++; return "git commit 500 ms"; } });
    slow.record({ name: "tool context", cls: "read", ms: 900, result: "ok" });
  });
  assert.deepEqual(info, ["tool set_plan ok 499 ms", "tool set_plan ok 500 ms; git commit 500 ms", "tool context ok 900 ms"]);
  assert.equal(asked, 1);
});

test("steps that cannot be told do not lose the line", async () => {
  const { info } = await logged(() => new SlowOps().record({ name: "tool set_plan", cls: "write", ms: 900, result: "ok", steps: () => { throw new Error("boom"); } }));
  assert.deepEqual(info, ["tool set_plan ok 900 ms"]);
});

test("a commit under a trace has a step for each place it waited or worked, git commands by name, in the order they ran", async t => {
  const { store } = await board(t);
  const trace = new WriteTrace();
  await withTrace(trace, () => store.commit({ author, message: "Traced write", puts: [put(1)] }));
  const line = trace.finish();
  const names = stepNames(line).filter(name => name !== "rest" && name !== "other");
  // git runs for a millisecond or more, so each of its steps is told; the pure code steps may be under a millisecond.
  for (const git of ["git diff", "git add", "git commit", "git show"]) assert.ok(names.includes(git), `${git} in: ${line}`);
  const order = names.filter(name => name.startsWith("git "));
  assert.deepEqual(order, ["git diff", "git add", "git commit", "git show"], line);
});

test("a slow git commit is the step that is slow, and the commands around it are not", async t => {
  const { store, dir } = await board(t);
  await slowCommits(dir, 0.6);
  const trace = new WriteTrace();
  await withTrace(trace, () => store.commit({ author, message: "Slow commit", puts: [put(1)] }));
  const line = trace.finish();
  assert.ok((stepMs(line, "git commit") ?? 0) >= 550, line);
  for (const other of ["git diff", "git add", "git show", "validate", "files", "publish", "listeners"]) assert.ok((stepMs(line, other) ?? 0) < 400, `${other} in: ${line}`);
});

test("a write that waits in the store's queue says how long, how many were ahead and what it was behind; the one ahead does not", async t => {
  const { store, dir } = await board(t);
  await slowCommits(dir, 0.5);
  // The first write's clock moves 2 ms at every reading, so its store queue step is never under a millisecond and left out of the
  // line (a loaded runner may take 1 ms to start a write with nobody ahead): the check below always sees the step.
  let now = 0;
  const first = new WriteTrace(() => (now += 2)), second = new WriteTrace();
  await Promise.all([
    withTrace(first, () => store.commit({ author, message: "First", puts: [put(1)] })),
    withTrace(second, () => store.commit({ author, message: "Second", puts: [put(2)] })),
  ]);
  const a = first.finish(), b = second.finish();
  assert.notEqual(stepMs(a, "store queue"), undefined, a);
  assert.doesNotMatch(a, /ahead|behind/, a);
  const wait = /store queue (\d+) ms \(1 ahead, behind write\)/.exec(b);
  assert.ok(wait, b);
  assert.ok(Number(wait[1]) >= 450, `the second waited out the first's commit: ${b}`);
});

test("a write behind a maintenance step is told so, and the step's git commands are no write's steps", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-trace-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const lines: string[] = [];
  const store = await Store.open(dir, { init: true, board: { title: "Trace" }, maintenance: { every: 1, log: line => lines.push(line) } });
  const first = new WriteTrace(), second = new WriteTrace();
  // The first commit queues a step as it ends; the second joins the queue behind it.
  await withTrace(first, () => store.commit({ author, message: "First", puts: [put(1)] }));
  await withTrace(second, () => store.commit({ author, message: "Second", puts: [put(2)] }));
  await store.flushOwner(author);
  const a = first.finish(), b = second.finish();
  assert.match(b, /store queue \d+ ms \(1 ahead, behind maintenance\)/, b);
  for (const line of [a, b]) assert.doesNotMatch(line, /git (repack|commit-graph|count-objects|multi-pack-index)/, line);
  assert.ok(lines.length >= 1, "the step ran");
});

test("a tool call that takes long says where it went; the writes behind it say how long they waited for it, and a quick one says nothing", async t => {
  const { store, op, dir } = await board(t);
  await slowCommits(dir, 0.6);
  const slow = new SlowOps(), mcp = createMcpServer({ store, ops: op, slow }), client = new Client({ name: "Trace test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  const { info } = await logged(async () => {
    assert.equal((await client.callTool({ name: "projects", arguments: {} })).isError, undefined);
    // Two writes at once: the second waits for the first in the call queue of the operations.
    const calls = await Promise.all([1, 2].map(n => client.callTool({ name: "append_log", arguments: { author, session: `trace-${n}`, id: "a", text: `entry ${n}` } })));
    for (const call of calls) assert.equal(call.isError, undefined);
  });
  assert.ok(info.some(line => /^tool projects ok \d+ ms$/.test(line)), info.join("\n"));
  const writes = info.filter(line => line.startsWith("tool append_log ok "));
  assert.equal(writes.length, 2, info.join("\n"));
  const steps = writes.map(line => line.slice(line.indexOf("; ") + 2));
  for (const line of writes) assert.match(line, /^tool append_log ok \d+ ms; /);
  for (const line of steps) {
    assert.ok((stepMs(line, "git commit") ?? 0) >= 550, line);
    // An append also reads the item's log (git log) before it commits; the commit's own commands come in this order.
    assert.deepEqual(stepNames(line).filter(name => ["git diff", "git add", "git commit", "git show"].includes(name)), ["git diff", "git add", "git commit", "git show"], line);
    assert.ok(stepNames(line).indexOf("ops queue") < stepNames(line).indexOf("git diff") || stepMs(line, "ops queue") === undefined, line);
  }
  const waited = steps.map(line => stepMs(line, "ops queue") ?? 0);
  assert.ok(Math.max(...waited) >= 550, `the second call waited for the first's commit: ${steps.join(" | ")}`);
  assert.ok(Math.min(...waited) < 300, `the first did not: ${steps.join(" | ")}`);
});

test("a page write that takes long says where it went, and reads carry no steps", async t => {
  const { store, op, dir } = await board(t);
  await slowCommits(dir, 0.6);
  const slow = new SlowOps(), http = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: join(import.meta.dirname, "../web"), slow, createMcp: () => createMcpServer({ store, ops: op, slow }) });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())));
  const address = http.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const { info } = await logged(async () => {
    assert.equal((await fetch(url + "/api/snapshot")).status, 200);
    const response = await fetch(url + "/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: "it:a", kind: "comment", text: "a note" }) });
    assert.equal(response.status, 200);
    await response.text();
    await sleep(20);
  });
  assert.ok(info.some(line => /^GET \/api\/snapshot 200 \d+ ms$/.test(line)), info.join("\n"));
  const line = info.find(l => l.startsWith("POST /api/notes 200 "));
  assert.ok(line, info.join("\n"));
  assert.ok((stepMs(line, "git commit") ?? 0) >= 550, line);
  assert.match(line, /; .*git add/, line);
});

test("a quick write is logged as before, with no steps", async t => {
  const { store, op } = await board(t);
  const slow = new SlowOps(), mcp = createMcpServer({ store, ops: op, slow }), client = new Client({ name: "Quick trace test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  const { info } = await logged(async () => { await client.callTool({ name: "append_log", arguments: { author, id: "a", text: "quick" } }); });
  assert.equal(info.length, 1, info.join("\n"));
  assert.match(info[0]!, /^tool append_log ok \d+ ms$/);
});
