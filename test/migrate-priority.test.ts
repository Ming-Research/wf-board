// The one-time migration that clears the retired item priority (an item file's `priority: P0 | P1 | P2`) from the board's data.
// Delete this file with src/migrate-priority*.ts and the store's start option once it has run on the live board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { parse, stringify } from "yaml";
import { Store } from "../src/store.ts";
import { unreadSteps } from "../src/history.ts";
import { timedWake } from "../src/timed-wake.ts";
import { ACTIVE_WINDOW_MS, ActivityIndex } from "../src/rules.ts";
import { priorityReport } from "../src/migrate-priority.ts";
import { board } from "./helpers.ts";

const exec = promisify(execFile);
// The roots of the synthetic board that hold a priority, as the live board's roots do, and the value each holds.
const HELD = { area: "P1", other: "P2" } as const;
const IDS = Object.keys(HELD);

/** The synthetic board with a priority written into two item files and committed by hand, as the live board holds it. */
async function withPriority(t: Parameters<typeof board>[0]) {
  const b = await board(t);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: b.dir })).stdout.trim();
  for (const [id, value] of Object.entries(HELD)) {
    const path = join(b.dir, `items/${id}.yaml`);
    await writeFile(path, stringify({ ...parse(await readFile(path, "utf8")) as object, priority: value }));
  }
  await git("add", ".");
  await git("-c", "user.name=Hand", "-c", "user.email=hand@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Give two roots a priority");
  return { ...b, git, heldHead: await git("rev-parse", "HEAD"), before: structuredClone(b.store.snapshot().items) };
}

test("a board that still holds a priority refuses to start and says how to clear it", async t => {
  const { dir } = await withPriority(t);
  await assert.rejects(Store.open(dir), (e: unknown) => {
    assert.ok(e instanceof Error);
    for (const id of IDS) assert.match(e.message, new RegExp(`items/${id}\\.yaml: priority: .*no longer exists`));
    assert.doesNotMatch(e.message, /items\/a\.yaml/, "only the items that hold it are named");
    return true;
  });
});

test("opening with the migration clears the priority from every item that holds it, in one commit, and from no other", async t => {
  const { dir, git, heldHead, before } = await withPriority(t);
  const count = async () => Number(await git("rev-list", "--count", "HEAD"));
  const commits = await count();
  const store = await Store.open(dir, { clearPriority: true });
  assert.equal(await count(), commits + 1, "one commit for every item");
  const [commit] = await store.log({ limit: 1 });
  assert.equal(commit!.message, "clear_priority 2 items");
  assert.deepEqual(commit!.files.sort(), IDS.map(id => `items/${id}.yaml`).sort());
  const s = store.snapshot();
  for (const id of IDS) {
    const it = s.items[id]!;
    assert.equal(Object.hasOwn(it, "priority"), false, `${id} stores no priority`);
    assert.equal(it.rev, before[id]!.rev + 1);
    // Nothing else moves: no log line, no new `updated`, so the item does not look changed.
    assert.deepEqual(it.log, before[id]!.log); assert.equal(it.updated, before[id]!.updated);
    assert.doesNotMatch(await readFile(join(dir, `items/${id}.yaml`), "utf8"), /priority/);
  }
  // The value stays in git history, as the commit removed it.
  for (const [id, value] of Object.entries(HELD)) assert.match(await git("show", "--format=", "HEAD", "--", `items/${id}.yaml`), new RegExp(`^-priority: ${value}$`, "m"));
  assert.deepEqual(s.items.a, before.a, "an item that held none is untouched");
  // The report keeps the value each item held as well.
  assert.deepEqual(store.clearedPriority, [{ id: "area", group: "Whitefoot", priority: "P1" }, { id: "other", group: "Firn", priority: "P2" }]);
  assert.deepEqual(priorityReport(store.clearedPriority), ["Cleared the retired priority of 2 items (P1 1, P2 1)", "area · Whitefoot · P1", "other · Firn · P2"]);
  // History keeps the value as written, and comparison reads the old version without it, so the owner sees nothing new.
  assert.equal((await store.show("item", "area", heldHead) as { priority?: string }).priority, "P1");
  assert.equal(Object.hasOwn((await store.comparisonSnapshot(heldHead)).items.area!, "priority"), false);
  const news = (await unreadSteps(store, heldHead)).filter(step => step.docs.some(d => IDS.includes(d.id)));
  assert.deepEqual(news, []);
});

test("the clearing is bookkeeping: it restarts no clock, starts no active time and is not news to the timed wake", async t => {
  const { dir, heldHead } = await withPriority(t);
  // Commit times have a resolution of one second; the clearing must not share the earlier commit's.
  await sleep(1100);
  const store = await Store.open(dir, { clearPriority: true });
  const [clearing, held] = await store.log({ limit: 2 });
  assert.equal(clearing!.message, "clear_priority 2 items"); assert.notEqual(clearing!.at, held!.at);
  const s = store.snapshot();
  for (const id of IDS) assert.equal(s.activity!.items[id], held!.at, `${id}'s last change is still the earlier commit's`);
  assert.equal(s.activity!.writes.at(-1), held!.at, "the clearing starts no active time");
  // What the rules read is that index and the items' own times: the clock of each root is still the earlier commit's, and no active window opens at the clearing.
  const index = ActivityIndex.build(s), now = Date.now();
  for (const id of IDS) assert.equal(index.changedAt(id, now), Date.parse(held!.at), `${id}'s change clock is not restarted`);
  // A clearing a second after the earlier commit would only lengthen its window, so the end of the last window is read far enough on.
  const windows = index.intervals(Date.parse(held!.at) + 3 * 60 * 60 * 1000);
  assert.equal(windows.at(-1)![1], Date.parse(held!.at) + ACTIVE_WINDOW_MS, "no active window opens or grows at the clearing");
  const fields = await timedWake(store, s, store.derived.rules(s, Date.now()), { at: held!.at, head: heldHead }, held!.at);
  assert.deepEqual(fields.changed, [], "and the timed wake lists nothing the clearing wrote");
});

test("the migration runs once: a second start with or without it writes nothing", async t => {
  const { dir, git } = await withPriority(t);
  const first = await Store.open(dir, { clearPriority: true });
  assert.equal(first.clearedPriority.length, 2);
  const head = await git("rev-parse", "HEAD");
  const again = await Store.open(dir);
  assert.deepEqual(again.clearedPriority, []);
  assert.deepEqual((await Store.open(dir, { clearPriority: true })).clearedPriority, []);
  assert.equal(await git("rev-parse", "HEAD"), head);
});
