// The unread list after a restart (item unread-after-restart). The list is a walk over the commits after the owner's read cursor, and the
// description of what each commit changed (its summary and what in it the owner can see) is made once and kept in the daemon's memory; a
// restart lost it, and a walk over the 11,725 commits the live board had after the cursor read 3.3 times what a request may read and ran
// for about 80 seconds. The descriptions are now kept in a file (src/unread-warm.ts) and the first request after a restart finds them.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { board, author, appendCommits } from "./helpers.ts";
import type { HistoryCommit } from "./helpers.ts";
import { cleanup } from "./cleanup.ts";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { createHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";
import { REQUEST_LIMITS } from "../src/budget.ts";
import type { BudgetLimits } from "../src/budget.ts";
import { DESCRIPTION_VERSION, commitsSince, descriptionsMade, exportDescriptions, importDescriptions, unreadSteps } from "../src/history.ts";
import { UnreadWarmer } from "../src/unread-warm.ts";

const quiet = (t: TestContext) => t.mock.method(console, "warn", () => {});
const folder = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-unread-"));
  cleanup(t, () => rm(dir, { recursive: true, force: true }));
  return dir;
};
/** A warmer that says what it logged, and no more. */
const warmer = (store: Store, dir: string, extra: { everyMs?: number } = {}) => {
  const lines: string[] = [], warnings: string[] = [];
  return { lines, warnings, warmer: new UnreadWarmer({ store, dir, ...extra, log: line => lines.push(line), warn: line => warnings.push(line) }) };
};

// The board of the live one's shape: a walk reads the files of each changed document before and after, and the live board's item files
// are 45 to 55 KB, so a commit made a walk read 107 KB where a request may read 32 KB (3.3 times; a gap of the budget, measured on the
// live data repository). Here the same ratio on a board 1/32 the size: files of about 1.5 KB read 3 KB a commit against 1 KB.
const SCALE = 32;
const SMALL: BudgetLimits = { ...REQUEST_LIMITS, bytes: REQUEST_LIMITS.bytes / SCALE, bytesPerCommit: REQUEST_LIMITS.bytesPerCommit / SCALE };
const COMMITS = 11_800, ITEMS = 120, START = 1_790_000_000;
const sentence = "看板服务读历史时只读需要的文件 and keeps the cost bounded by the range. ";
const head = sentence.repeat(Math.ceil(1500 / Buffer.byteLength(sentence)));
const revs = new Map<string, number>();
/** An item file: a log of one line that each write replaces (the file keeps its size), a head, and the plan rows the visible writes change. */
const itemDoc = (id: string, k: number, step?: string) => {
  const rev = (revs.get(id) ?? 0) + 1;
  revs.set(id, rev);
  const at = new Date((START + k) * 1000).toISOString();
  return { title: `Work ${id}`, group: "Whitefoot", difficulty: 2, head, log: [{ at, by: author, text: `entry ${k}` }], plan: [{ id: "accept", accept: true, text: "passes", state: "todo" }, ...(step ? [{ id: "step", text: step, state: "todo" }] : [])], updated: at, rev };
};
/** `count` commits after the cursor, in runs of six: two log writes (nothing the owner reads), two plan writes to one item by one author (one
 * stop of two commits), one to another item by another author (a stop of one), and a log write. */
function history(count: number): HistoryCommit[] {
  const plans = new Map<string, string>();
  return Array.from({ length: count }, (_, k) => {
    const run = Math.floor(k / 6), slot = k % 6, id = (n: number) => `w${(run * 7 + n) % ITEMS}`;
    const target = [id(0), id(1), id(2), id(2), id(3), id(2)][slot]!, visible = slot === 2 || slot === 3 || slot === 4;
    if (visible) plans.set(target, `step ${k}`);
    return { at: START + k, message: visible ? `set_plan ${target}` : `append_log ${target}`, author: slot === 4 ? "Architect" : author, session: slot === 4 ? "架构师" : "eng", files: { [`items/${target}.yaml`]: itemDoc(target, k, plans.get(target)) } };
  });
}

async function serve(t: TestContext, store: Store, budget: BudgetLimits) {
  const http = createHttpServer({ store, ops: ops(store), ownerOps: ownerOps(store), webDir: join(import.meta.dirname, "../web"), createMcp: () => createMcpServer({ store, ops: ops(store), budget }), budget });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  cleanup(t, () => new Promise<void>(resolve => http.close(() => resolve())));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  return async () => { const t0 = performance.now(), response = await fetch(url + "/api/unread"); return { status: response.status, data: await response.json() as { steps: unknown[]; error?: string }, ms: performance.now() - t0 }; };
}

test("after a restart the first request for the unread list is answered from the file of the run before, within the budget of a request", async t => {
  quiet(t);
  const { dir } = await board(t);
  await appendCommits(dir, [{ at: START - 1, message: "Seed items", files: Object.fromEntries(Array.from({ length: ITEMS }, (_, n) => [`items/w${n}.yaml`, itemDoc(`w${n}`, 0)])) }]);
  // The owner has read up to here, and the daemon that wrote it stopped (its reading state is committed at an orderly shutdown).
  const reading = await Store.open(dir);
  reading.setOwner({ cursor: reading.snapshot().head });
  await reading.flushOwner("owner");
  await appendCommits(dir, history(COMMITS));
  const files = await folder(t);

  // The run before: the walk over every commit after the cursor, which the daemon makes in the background with a budget for it.
  const first = await Store.open(dir), run1 = warmer(first, files);
  await run1.warmer.load();
  let started = performance.now();
  await run1.warmer.warm();
  t.diagnostic(`cold walk over ${COMMITS} commits: ${Math.round(performance.now() - started)} ms; ${run1.lines.at(-1)}`);
  assert.deepEqual(run1.warnings, []);
  const { head: tip, owner } = first.snapshot();
  const before = await unreadSteps(first, owner.cursor, owner.readMarks ?? {}, tip);
  assert.ok(before.length > 3000 && before.some(step => step.commits.length === 2), `the walk has stops of one and of two commits (${before.length})`);
  const written = await stat(join(files, "descriptions.json"));
  t.diagnostic(`the file: ${written.size} bytes`);
  assert.ok(written.size > 0, "and the file is written");

  // The restart: a store opened on the same data with nothing in memory, and the file loaded as the daemon does before it serves.
  const second = await Store.open(dir, { requireBudget: true }), run2 = warmer(second, files);
  await run2.warmer.load();
  assert.match(run2.lines[0]!, /unread descriptions: \d+ loaded/);
  const compared = t.mock.method(second, "comparisonDocuments");
  const request = await serve(t, second, SMALL);
  const answer = await request();
  t.diagnostic(`first request after the restart: ${Math.round(answer.ms)} ms`);
  assert.equal(answer.status, 200, String(answer.data.error));
  // The line the board gives a request that reads history is 10 seconds (docs/design.md, section 4, Time limits).
  assert.ok(answer.ms < 10_000, `${Math.round(answer.ms)} ms`);
  assert.deepEqual(answer.data.steps, JSON.parse(JSON.stringify(before)), "the list is the one the run before derived from the history");
  assert.equal(compared.mock.callCount(), 0, "and no document was read from the history to make it");
  // The round that follows has nothing to add: what it exports is the text of the file it loaded, so it writes nothing.
  const kept = await stat(join(files, "descriptions.json"));
  await run2.warmer.warm();
  assert.deepEqual(run2.lines.filter(line => line.startsWith("unread warm-up:")), []);
  assert.equal((await stat(join(files, "descriptions.json"))).mtimeMs, kept.mtimeMs);

  // Without the file, which is how it was before: a restart reads what a walk reads and a request cannot.
  const third = await Store.open(dir, { requireBudget: true });
  const cold = await (await serve(t, third, SMALL))();
  assert.equal(cold.status, 413);
  assert.match(String(cold.data.error), /History budget exceeded: this GET \/api\/unread read .* of board history/);
});

test("the file holds the descriptions of the commits after the cursor, and a file that is missing, of another version or damaged is ignored", async t => {
  quiet(t);
  const { dir, store, op } = await board(t), cursor = store.snapshot().head, files = await folder(t);
  await op.setPlan({ author, id: "a", row: { id: "one", state: "todo", text: "One" } });
  await op.appendLog({ author, id: "b", text: "Internal" });
  await op.setPlan({ author, id: "b", row: { id: "two", state: "todo", text: "Two" } });
  const listed = await unreadSteps(store, cursor), commits = await commitsSince(store, cursor, store.snapshot().head);
  const { text, entries } = exportDescriptions(store, new Set(commits.map(commit => commit.commit)));
  assert.equal(entries, 3, "one for each commit that changed a document: the log write among them, as nothing to read");
  assert.equal(Object.values(JSON.parse(text).entries).filter(entry => entry === 0).length, 1);
  assert.equal(exportDescriptions(store, new Set([commits[0]!.commit])).entries, 1, "only the commits asked for");
  assert.equal(exportDescriptions(store, new Set()).entries, 0);

  // A store with nothing in memory that is given the file reads no document to make the same list.
  const loaded = await Store.open(dir), compared = t.mock.method(loaded, "comparisonDocuments");
  assert.equal(importDescriptions(loaded, text), 3);
  assert.equal(importDescriptions(loaded, text), 0, "what the store has is kept");
  assert.equal(descriptionsMade(loaded), 0, "and what was loaded is not counted as made");
  assert.deepEqual(await unreadSteps(loaded, cursor), listed);
  assert.equal(compared.mock.callCount(), 0);

  // Missing, another version, not JSON, a count that is not a number: the walk describes the commits again, and is right.
  const bad = [undefined, JSON.stringify({ version: DESCRIPTION_VERSION + 1, entries: {} }), "{ not json", JSON.stringify({ version: DESCRIPTION_VERSION, entries: { "commit|x|item|a": [1, 2, 3, 4] } })];
  for (const [n, content] of bad.entries()) {
    const directory = await folder(t);
    if (content !== undefined) await writeFile(join(directory, "descriptions.json"), content);
    const restarted = await Store.open(dir), run = warmer(restarted, directory);
    await run.warmer.load();
    assert.equal(run.warnings.length, content === undefined ? 0 : 1, `file ${n}`);
    assert.equal(descriptionsMade(restarted), 0);
    assert.deepEqual(await unreadSteps(restarted, cursor), listed, `file ${n}`);
    assert.ok(descriptionsMade(restarted) > 0, "the commits were described again");
  }
});

test("a round writes the file only when the walk made descriptions, and a restart then describes only the commits since", async t => {
  const { dir, store, op } = await board(t), files = await folder(t);
  const cursor = store.snapshot().head;
  store.setOwner({ cursor });
  await op.setPlan({ author, id: "a", row: { id: "one", state: "todo", text: "One" } });
  const run = warmer(store, files, { everyMs: 5 * 60_000 }), file = join(files, "descriptions.json");
  t.mock.timers.enable({ apis: ["setInterval"] });
  run.warmer.start();
  await run.warmer.warm();
  assert.equal(run.lines.filter(line => line.startsWith("unread warm-up:")).length, 1);
  const written = await stat(file);
  // Nothing was written to the board since: the round walks the same range and makes nothing, so the file stays as it is.
  t.mock.timers.tick(5 * 60_000);
  await run.warmer.warm();
  assert.equal(run.lines.filter(line => line.startsWith("unread warm-up:")).length, 1);
  assert.equal((await stat(file)).mtimeMs, written.mtimeMs);
  // A write, and the round after the interval describes it and rewrites the file.
  await op.setPlan({ author, id: "b", row: { id: "two", state: "todo", text: "Two" } });
  const size = (await readFile(file)).length;
  t.mock.timers.tick(5 * 60_000);
  await run.warmer.warm();
  assert.equal(run.lines.filter(line => line.startsWith("unread warm-up:")).length, 2);
  assert.match(run.lines.at(-1)!, /2 commits after the read cursor, 1 described, 2 kept in the file/);
  assert.ok((await readFile(file)).length > size);

  // The restart after one more write: the file holds the commits before it, and the walk describes only that one.
  await op.setPlan({ author, id: "a", row: { id: "three", state: "todo", text: "Three" } });
  const restarted = await Store.open(dir), after = warmer(restarted, files);
  await after.warmer.load();
  const compared = t.mock.method(restarted, "comparisonDocuments");
  await unreadSteps(restarted, cursor);
  assert.equal(compared.mock.callCount(), 1);
  run.warmer.stop();
});

test("stopping ends the walk of the round that is running and starts no other, and leaves the walk of a request to finish", async t => {
  const { store, op } = await board(t), files = await folder(t), cursor = store.snapshot().head;
  store.setOwner({ cursor });
  await op.setPlan({ author, id: "a", row: { id: "one", state: "todo", text: "One" } });
  await op.setPlan({ author, id: "b", row: { id: "two", state: "todo", text: "Two" } });
  const run = warmer(store, files), describe = store.comparisonDocuments.bind(store);
  // The signal comes while the round describes its first commit.
  t.mock.method(store, "comparisonDocuments", async (...args: Parameters<typeof store.comparisonDocuments>) => { run.warmer.stop(); return describe(...args); });
  await run.warmer.warm();
  assert.deepEqual(run.warnings, [], "the end of a round by the stop is no failure");
  assert.equal(descriptionsMade(store), 1, "the round ended at its second commit");
  await assert.rejects(stat(join(files, "descriptions.json")), "and wrote nothing");
  // A request of the same reading state is not under the signal: its walk finishes.
  assert.equal((await unreadSteps(store, cursor)).length, 2);
  assert.equal(descriptionsMade(store), 2);
  // No round starts after the stop.
  await run.warmer.warm();
  assert.deepEqual([run.lines, run.warnings], [[], []]);
});

test("the descriptions the file keeps read as they did when DESCRIPTION_VERSION was set", async t => {
  // If this fails because a change now reads differently to the owner (the summary of a change, or what counts as something to read), raise
  // DESCRIPTION_VERSION in src/history.ts with it, so that a file of the descriptions made before is not used for the commits it describes.
  assert.equal(DESCRIPTION_VERSION, 1);
  const { store, op } = await board(t), cursor = store.snapshot().head;
  await op.setPlan({ author, id: "a", row: { id: "work", state: "todo", text: "Work" } });
  await op.appendLog({ author, id: "a", text: "Internal" });
  await op.updateItem({ author, id: "a", rev: store.snapshot().items.a!.rev, head: "A new head", reason: "Internal reason" });
  const steps = await unreadSteps(store, cursor);
  assert.deepEqual(steps.map(step => step.docs.map(doc => [doc.kind, doc.id, doc.summary, doc.pieces])), [
    [["item", "a", "plan changed", { progress: 1, reply: 0, other: 0 }]],
    [["item", "a", "head changed", { progress: 0, reply: 0, other: 1 }]],
  ]);
});
