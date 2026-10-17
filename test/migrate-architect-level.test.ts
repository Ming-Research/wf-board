// The one-time migration that clears the retired level 「架构师做」 (an item file's `difficulty: architect`) from the board's data.
// Delete this file with src/migrate-architect-level*.ts and the store's start option once it has run on the live board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { Store } from "../src/store.ts";
import { unreadSteps } from "../src/history.ts";
import { board } from "./helpers.ts";

const exec = promisify(execFile);
const RETIRED = ["area", "other"];

/** The synthetic board with the retired level written into two item files and committed by hand, as the live board holds it. */
async function withRetiredLevel(t: Parameters<typeof board>[0]) {
  const b = await board(t);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: b.dir })).stdout.trim();
  for (const id of RETIRED) {
    const path = join(b.dir, `items/${id}.yaml`);
    await writeFile(path, stringify({ ...parse(await readFile(path, "utf8")) as object, difficulty: "architect" }));
  }
  await git("add", ".");
  await git("-c", "user.name=Hand", "-c", "user.email=hand@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Rate two items 架构师做");
  return { ...b, git, retiredHead: await git("rev-parse", "HEAD"), before: structuredClone(b.store.snapshot().items) };
}

test("a board that still holds the retired level refuses to start and says how to clear it", async t => {
  const { dir } = await withRetiredLevel(t);
  await assert.rejects(Store.open(dir), (e: unknown) => {
    assert.ok(e instanceof Error);
    for (const id of RETIRED) assert.match(e.message, new RegExp(`items/${id}\\.yaml: difficulty: .*架构师做.*npm run migrate:architect-level`));
    assert.doesNotMatch(e.message, /items\/a\.yaml/, "only the items that hold it are named");
    return true;
  });
});

test("opening with the migration clears the level from every item that holds it, in one commit, and from no other", async t => {
  const { dir, git, retiredHead, before } = await withRetiredLevel(t);
  const count = async () => Number(await git("rev-list", "--count", "HEAD"));
  const commits = await count();
  const store = await Store.open(dir, { clearArchitectLevel: true });
  assert.equal(await count(), commits + 1, "one commit for every item");
  const [commit] = await store.log({ limit: 1 });
  assert.equal(commit!.message, "clear_architect_level 2 items");
  assert.deepEqual(commit!.files.sort(), RETIRED.map(id => `items/${id}.yaml`).sort());
  const s = store.snapshot();
  for (const id of RETIRED) {
    const it = s.items[id]!;
    assert.equal(it.difficulty, undefined, `${id} is unrated`);
    assert.equal(it.rev, before[id]!.rev + 1);
    assert.deepEqual(it.log.slice(0, -1), before[id]!.log, "the log keeps every earlier line");
    assert.deepEqual([it.log.at(-1)!.by, it.log.at(-1)!.text], ["wf-board", "难度：架构师做 → 未评，理由：迁移：这一级已取消，条目都评 1–5 级，等 PM 评级"]);
    assert.doesNotMatch(await readFile(join(dir, `items/${id}.yaml`), "utf8"), /difficulty/);
  }
  assert.deepEqual(s.items.a, before.a, "an item that held no such level is untouched");
  // The owner sees nothing new: the old version is read without the retired level, so the commit changes no visible field.
  const news = (await unreadSteps(store, retiredHead)).filter(step => step.docs.some(d => RETIRED.includes(d.id)));
  assert.deepEqual(news, []);
});

test("the migration runs once: a second start with or without it writes nothing", async t => {
  const { dir, git } = await withRetiredLevel(t);
  const first = await Store.open(dir, { clearArchitectLevel: true });
  assert.deepEqual(RETIRED.map(id => first.snapshot().items[id]!.difficulty), [undefined, undefined]);
  const head = await git("rev-parse", "HEAD");
  await Store.open(dir);
  await Store.open(dir, { clearArchitectLevel: true });
  assert.equal(await git("rev-parse", "HEAD"), head);
});

test("the command clears a copy of the data, prints what it did, and needs --data", async t => {
  const { dir } = await withRetiredLevel(t);
  const cli = join(import.meta.dirname, "../src/migrate-architect-level-cli.ts");
  const copy = `${dir}-copy`;
  await cp(dir, copy, { recursive: true });
  t.after(() => exec("rm", ["-rf", copy]));
  const done = await exec(process.execPath, [cli, "--data", copy]);
  assert.match(done.stdout, /Cleared the retired level from 2 items: area, other/);
  const again = await exec(process.execPath, [cli, "--data", copy]);
  assert.match(again.stdout, /Nothing to migrate/);
  await Store.open(copy);
  const missing = await exec(process.execPath, [cli]).then(() => undefined, (e: { code: number; stderr: string }) => e);
  assert.equal(missing?.code, 1); assert.match(missing!.stderr, /Usage: npm run migrate:architect-level -- --data DIR/);
});
