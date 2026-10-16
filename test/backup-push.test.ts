import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { BackupPush, BACKUP_LAG_MS } from "../src/backup-push.ts";
import { Wake } from "../src/wake.ts";

// The watch on the remote copy of the board's data (docs/design.md, Storage): a push that fails or stalls costs no write any time, so
// its only harm is a copy that falls behind, and the architect is told when it has stayed behind for an hour.

const MINUTE = 60_000;
const start = Date.parse("2026-10-16T08:00:00Z");

/** The store's side of a push as the watch sees it: how many commits the remote lacks, and what a push does. */
function world(t: TestContext) {
  t.mock.method(console, "info", () => {}); t.mock.method(console, "error", () => {});
  const w = {
    now: start, commits: 3, failure: undefined as string | undefined,
    pushes: [] as Array<AbortSignal | undefined>,
    hang: undefined as ((signal: AbortSignal) => Promise<boolean>) | undefined,
  };
  const store = {
    unpushed: async () => w.commits,
    push: async (signal?: AbortSignal) => {
      w.pushes.push(signal);
      if (w.hang) return w.hang(signal!);
      if (w.failure) throw new Error(w.failure);
      w.commits = 0;
      return true;
    },
  };
  const wake = new Wake({ now: () => w.now });
  const backup = new BackupPush({ store, wake, now: () => w.now });
  const frames = () => wake.since(0).frames.map(({ n: _n, at: _at, ...frame }) => frame);
  /** A round `minutes` after the start of the world; its rejection is the push's failure and is not the test's concern. */
  const round = async (minutes: number) => { w.now = start + minutes * MINUTE; await backup.round().catch(() => {}); };
  return { w, backup, frames, round };
}

test("a copy that stays behind for an hour is told once, with the commits left, the last success and the last failure", async t => {
  const { w, frames, round } = world(t);
  w.failure = "git push killed by the cap after 300 s";
  for (let minutes = 10; minutes < 60; minutes += 10) await round(minutes);
  assert.deepEqual(frames(), [], "not yet an hour");
  await round(60);
  assert.deepEqual(frames(), [{ event: "backup-behind", commits: 3, lastSuccess: null, reason: "git push killed by the cap after 300 s" }], "an hour since the start, which nothing has confirmed");
  for (let minutes = 70; minutes <= 130; minutes += 10) await round(minutes);
  assert.equal(frames().length, 1, "told once while the copy stays behind");
});

test("a copy that is current again and falls behind again is told again, with the time of the last success", async t => {
  const { w, frames, round } = world(t);
  w.failure = "no route";
  await round(10); await round(70);
  assert.equal(frames().length, 1);
  w.failure = undefined;
  await round(80);
  assert.equal(w.commits, 0);
  w.commits = 2; w.failure = "no route again";
  for (let minutes = 90; minutes < 140; minutes += 10) await round(minutes);
  assert.equal(frames().length, 1, "less than an hour after the success at minute 80");
  await round(140);
  assert.deepEqual(frames().at(-1), { event: "backup-behind", commits: 2, lastSuccess: new Date(start + 80 * MINUTE).toISOString(), reason: "no route again" });
  assert.equal(frames().length, 2);
});

test("a copy with nothing to send is current however long it is left alone", async t => {
  const { w, frames, round } = world(t);
  w.commits = 0;
  await round(180);
  w.commits = 1; w.failure = "no route";
  await round(190);
  assert.deepEqual(frames(), [], "ten minutes behind");
  await round(230);
  assert.deepEqual(frames(), [], "an hour is counted from the last time the copy was current");
  await round(240);
  assert.equal(frames().length, 1);
});

test("the lag is an hour", () => {
  assert.equal(BACKUP_LAG_MS, 60 * MINUTE);
});

test("stopping ends the push that runs, tells nobody and starts no other", async t => {
  const { w, backup, frames, round } = world(t);
  w.hang = signal => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("git push stopped on request")), { once: true }); });
  w.now = start + 2 * 60 * MINUTE;
  const running = backup.round();
  while (w.pushes.length === 0) await new Promise(resolve => setImmediate(resolve));
  backup.stop();
  await Promise.race([running, new Promise((_resolve, reject) => setTimeout(() => reject(new Error("the round did not end after stop()")), 3000))]);
  assert.deepEqual(frames(), [], "a push stopped by the shutdown is no failure of the copy");
  await round(130);
  assert.equal(w.pushes.length, 1, "no push is started after the stop");
});

test("a round that starts while another runs does nothing", async t => {
  const { w, backup } = world(t);
  let release!: (sent: boolean) => void;
  w.hang = () => new Promise<boolean>(resolve => { release = resolve; });
  const first = backup.round();
  while (w.pushes.length === 0) await new Promise(resolve => setImmediate(resolve));
  await backup.round();
  assert.equal(w.pushes.length, 1);
  release(true);
  await first;
});
