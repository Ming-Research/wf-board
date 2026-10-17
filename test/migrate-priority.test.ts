// The one-time migration that clears the retired item priority (an item file's `priority: P0 | P1 | P2`) from the board's data.
// Delete this file with src/migrate-priority*.ts and the store's start option once it has run on the live board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { Store } from "../src/store.ts";
import { unreadSteps } from "../src/history.ts";
import { clearedPriorityLog, priorityReport } from "../src/migrate-priority.ts";
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
    for (const id of IDS) assert.match(e.message, new RegExp(`items/${id}\\.yaml: priority: .*migrate:priority`));
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
  for (const [id, value] of Object.entries(HELD)) {
    const it = s.items[id]!;
    assert.equal(Object.hasOwn(it, "priority"), false, `${id} stores no priority`);
    assert.equal(it.rev, before[id]!.rev + 1);
    assert.deepEqual(it.log.slice(0, -1), before[id]!.log, "the log keeps every earlier line");
    assert.deepEqual([it.log.at(-1)!.by, it.log.at(-1)!.text], ["wf-board", `优先级：${value} → 去掉，理由：迁移：先做什么改由架构师定，必须先做的用依赖表达`]);
    assert.equal(it.log.at(-1)!.text, clearedPriorityLog(value));
    assert.doesNotMatch(await readFile(join(dir, `items/${id}.yaml`), "utf8"), /priority/);
  }
  assert.deepEqual(s.items.a, before.a, "an item that held none is untouched");
  // The report keeps the value each item held, whatever the log says later.
  assert.deepEqual(store.clearedPriority, [{ id: "area", group: "Whitefoot", priority: "P1" }, { id: "other", group: "Firn", priority: "P2" }]);
  assert.deepEqual(priorityReport(store.clearedPriority), ["Cleared the retired priority of 2 items (P1 1, P2 1)", "area · Whitefoot · P1", "other · Firn · P2"]);
  // History keeps the value as written, and comparison reads the old version without it, so the owner sees nothing new.
  assert.equal((await store.show("item", "area", heldHead) as { priority?: string }).priority, "P1");
  assert.equal(Object.hasOwn((await store.comparisonSnapshot(heldHead)).items.area!, "priority"), false);
  const news = (await unreadSteps(store, heldHead)).filter(step => step.docs.some(d => IDS.includes(d.id)));
  assert.deepEqual(news, []);
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

test("the command clears a copy of the data, prints each item's value, and needs --data", async t => {
  const { dir } = await withPriority(t);
  const cli = join(import.meta.dirname, "../src/migrate-priority-cli.ts");
  const copy = `${dir}-copy`;
  await cp(dir, copy, { recursive: true });
  t.after(() => exec("rm", ["-rf", copy]));
  const done = await exec(process.execPath, [cli, "--data", copy]);
  assert.match(done.stdout, /Cleared the retired priority of 2 items \(P1 1, P2 1\)\narea · Whitefoot · P1\nother · Firn · P2\nCommit [0-9a-f]{40}/);
  const again = await exec(process.execPath, [cli, "--data", copy]);
  assert.match(again.stdout, /Nothing to migrate/);
  await Store.open(copy);
  const missing = await exec(process.execPath, [cli]).then(() => undefined, (e: { code: number; stderr: string }) => e);
  assert.equal(missing?.code, 1); assert.match(missing!.stderr, /Usage: npm run migrate:priority -- --data DIR/);
});
