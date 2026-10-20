// The start-up of a board with a long history: the daemon's log of its start-up steps, and that the time to start does not grow
// with the history once the startup cache is written. A file of its own beside test/startup-cache.test.ts, which holds what the cache
// holds and when it is refused, because the measurement of the start takes most of the time of the two.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { stringify } from "yaml";
import { Store } from "../src/store.ts";
import { cleanup } from "./cleanup.ts";
import { at, item, owns, put, git, setup, cacheFile } from "./startup-board.ts";

/** Items alike in count, history of any length: a git history written with fast-import, whose files stay valid documents. */
async function bulkBoard(t: { after(fn: () => Promise<void>): void }, items: number, commits: number) {
  const { dir, store } = await setup(t);
  await store.commit({ author: "Fixture", message: "Seed", puts: [
    put("i0", { ...item("Item 0"), plan: [owns("i1"), owns("i2"), ...item().plan] }),
    ...Array.from({ length: items - 1 }, (_, i) => put(`i${i + 1}`, item(`Item ${i + 1}`))),
    ...Array.from({ length: 20 }, (_, i) => ({ kind: "decision" as const, id: `card${i}`, expectRev: null, doc: { item: `i${i + 1}`, question: "Q", options: [{ key: "A", text: "A" }], status: "open", updated: at } })),
    ...Array.from({ length: 30 }, (_, i) => ({ kind: "note" as const, id: `n${i}`, expectRev: null, doc: { target: `q:card${i % 20}`, kind: "comment", text: "N", at, state: "draft" } })),
  ] });
  const s = store.snapshot(), current: Record<string, unknown> = {};
  for (const [id, doc] of Object.entries(s.items)) current[`items/${id}.yaml`] = doc;
  for (const [id, doc] of Object.entries(s.decisions)) current[`decisions/${id}.yaml`] = doc;
  for (const [id, doc] of Object.entries(s.notes)) current[`notes/${id}.yaml`] = doc;
  const base = Math.floor(Date.now() / 1000) + 60, parts: Buffer[] = [];
  const text = (value: string) => Buffer.from(value);
  for (let k = 1; k <= commits; k++) {
    const when = base + k * 60, time = new Date(when * 1000).toISOString();
    const changed: string[] = [];
    const edit = (path: string, change: (doc: Record<string, unknown>) => Record<string, unknown>) => {
      const doc = change({ ...(current[path] as Record<string, unknown>) });
      current[path] = doc; changed.push(path);
    };
    if (k === 10) edit("items/i0.yaml", doc => ({ ...doc, updated: time, paused: { reason: "Owner chose to wait", at: time } }));
    else if (k === 20) edit("items/i0.yaml", doc => { const { paused: _, ...rest } = doc; return { ...rest, updated: time }; });
    else edit(`items/i${1 + (k % (items - 1))}.yaml`, doc => ({ ...doc, updated: time }));
    if (k % 10 === 0) {
      edit(`decisions/card${k % 20}.yaml`, doc => ({ ...doc, updated: time }));
      edit(`notes/n${k % 30}.yaml`, doc => ({ ...doc, text: `Note at ${time}` }));
    }
    const message = `Write ${k}\n\nSession: s${k % 7}`;
    parts.push(text(`commit refs/heads/main\nauthor Fixture <fixture@wf-board.invalid> ${when} +0000\ncommitter wf-board <wf-board@wf-board.invalid> ${when} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${k === 1 ? "from refs/heads/main^0\n" : ""}`));
    for (const path of changed) {
      const body = Buffer.from(stringify(current[path], { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" }));
      parts.push(text(`M 100644 inline ${path}\ndata ${body.length}\n`), body, text("\n"));
    }
  }
  const child = spawn("git", ["fast-import", "--quiet"], { cwd: dir, stdio: ["pipe", "inherit", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`git fast-import exited with ${code}: ${stderr}`))); });
  child.stdin.end(Buffer.concat(parts));
  await done;
  await git(dir, "reset", "--hard", "-q", "HEAD");
  return dir;
}

/** The daemon as a process on `dir`, stopped with the test: how long it says it took to listen, and the lines it printed. */
async function daemon(t: { after(fn: () => Promise<void>): void }, dir: string) {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  probe.close(); await once(probe, "close");
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/main.ts")], { env: { ...process.env, WF_BOARD_DATA: dir, WF_BOARD_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  let buffer = "";
  const listening = new Promise<number>((resolve, reject) => {
    const read = (chunk: Buffer) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); lines.push(line);
        const told = /startup listening: (\d+) ms/.exec(line);
        if (told) resolve(Number(told[1]));
      }
    };
    child.stdout.on("data", read); child.stderr.on("data", read);
    child.on("exit", code => reject(new Error(`the daemon exited with ${code}:\n${lines.join("\n")}`)));
  });
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } };
  // Registered after the directory it runs on, so it is stopped before that goes (test/cleanup.ts).
  cleanup(t, stop);
  return { port, lines, listening, stop };
}

test("the daemon's log carries the time on every line and the time of each start-up step", async t => {
  const { dir } = await setup(t);
  const started = await daemon(t, dir);
  await started.listening;
  const health = await (await fetch(`http://127.0.0.1:${started.port}/health`)).json() as { ok: boolean };
  assert.equal(health.ok, true);
  await started.stop();
  assert.ok(started.lines.length > 5);
  for (const line of started.lines) assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, "every line starts with its time");
  for (const step of ["read documents", "check board", "number documents", "read startup cache", "read git log", "replay activity", "replay pauses", "write startup cache", "maintenance", "open store", "create wake, watch and server", "listening"]) {
    assert.ok(started.lines.some(line => line.includes(`startup ${step}:`)), `the log has the step ${step}`);
  }
});

test("start-up time does not grow with the history: the same documents under ten times the commits start within twice the time", async t => {
  const items = 200, short = 400, long = 4000, rounds = 5;
  const small = await bulkBoard(t, items, short), large = await bulkBoard(t, items, long);
  const time = async (dir: string) => { const from = performance.now(); await Store.open(dir); return performance.now() - from; };
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  // The control: with no cache the start scans the history, so the same measurement must tell the two boards apart. One pair
  // measured once is not enough: the first scan of the process is slowed by the code not yet compiled, and a busy moment of the
  // machine falls on one board, which once made the ratio 1.87 where it is 2.4 to 3.4. So three pairs, the order turned each
  // time, and the medians.
  const scansSmall: number[] = [], scansLarge: number[] = [];
  const scan = async (dir: string, into: number[]) => { await rm(await cacheFile(dir), { force: true }); into.push(await time(dir)); };
  for (let round = 0; round < 3; round++) {
    if (round % 2 === 0) { await scan(small, scansSmall); await scan(large, scansLarge); } else { await scan(large, scansLarge); await scan(small, scansSmall); }
  }
  const scanSmall = median(scansSmall), scanLarge = median(scansLarge);
  assert.ok(scanLarge / scanSmall > 2, `a scan of ten times the history takes more than twice as long (medians ${scanLarge.toFixed(0)} ms against ${scanSmall.toFixed(0)} ms; all ${scansLarge.map(x => x.toFixed(0))} and ${scansSmall.map(x => x.toFixed(0))})`);
  // The scans wrote the caches. Interleave the starts so that a slow moment of the machine falls on both boards.
  const withSmall: number[] = [], withLarge: number[] = [];
  for (let round = 0; round < rounds; round++) { withSmall.push(await time(small)); withLarge.push(await time(large)); }
  const ratio = median(withLarge) / median(withSmall);
  t.diagnostic(`${items} items; ${short} and ${long} commits; median scan ${scanSmall.toFixed(0)} ms and ${scanLarge.toFixed(0)} ms (ratio ${(scanLarge / scanSmall).toFixed(2)}); with the cache, median of ${rounds} starts ${median(withSmall).toFixed(0)} ms and ${median(withLarge).toFixed(0)} ms (ratio ${ratio.toFixed(2)}); all ${withSmall.map(x => x.toFixed(0))} and ${withLarge.map(x => x.toFixed(0))}`);
  assert.ok(ratio <= 2, `with the cache, ten times the commits start in ${ratio.toFixed(2)} times the time`);
  // The same through the daemon: the time it logs from the start of the process to listening.
  const daemonSmall: number[] = [], daemonLarge: number[] = [];
  for (let round = 0; round < 3; round++) {
    for (const [dir, into] of [[small, daemonSmall], [large, daemonLarge]] as const) {
      const started = await daemon(t, dir);
      into.push(await started.listening);
      await started.stop();
    }
  }
  const daemonRatio = median(daemonLarge) / median(daemonSmall);
  t.diagnostic(`daemon, process start to listening: ${daemonSmall} ms and ${daemonLarge} ms (median ratio ${daemonRatio.toFixed(2)})`);
  assert.ok(daemonRatio <= 2, `the daemon with ten times the commits is listening in ${daemonRatio.toFixed(2)} times the time`);
  const reread = await Store.open(large);
  assert.equal(Object.keys(reread.snapshot().items).length, items);
  assert.equal(reread.snapshot().activity!.writes.length, long + 1 + 1, "the seed, the initial commit and every imported commit are in the index");
});
