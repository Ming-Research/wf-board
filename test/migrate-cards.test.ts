import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { Decision } from "../src/model.ts";
import { Store, readRawCardData, CARD_MIGRATION_MESSAGE } from "../src/store.ts";
import { migrateCards } from "../src/migrate-cards.ts";
import type { CardMigrationInput } from "../src/migrate-cards.ts";
import { unreadSteps } from "../src/history.ts";

const exec = promisify(execFile);
const at = "2026-10-11T01:02:03Z", t1 = "2026-10-11T02:00:00Z", t2 = "2026-10-11T03:00:00Z", sent = "2026-10-12T04:05:06Z", now = "2026-10-16T00:00:00Z";

const item = (extra: Record<string, unknown>) => ({ title: "Work", group: "P", plan: [{ id: "accept", accept: true, text: "Checked", state: "todo" }], log: [], links: [], updated: at, rev: 1, ...extra });
const card = (n: number, extra: Record<string, unknown>) => ({ num: n, item: "a", question: "Which?", background: "Old background", options: [{ key: "A", text: "First", recommended: true }, { key: "B", text: "Second" }],
  status: "ruled", choice: "A", ruling: "Old ruling", ruledAt: t1, order: 3, at, updated: at, rev: 1, ...extra });
/** The board before cards joined the plans: every shape the live data had (own rows, missing rows, foreign rows, an answered open card). */
function old(): CardMigrationInput {
  return {
    board: { title: "Synthetic", projects: [{ name: "P" }] },
    items: {
      r: item({ num: 1, priority: "P1", title: "Root", plan: [{ id: "a", item: "a", own: true, after: [] }, { id: "z", item: "z", own: true, after: [] }, { id: "accept", accept: true, text: "Checked", state: "todo" }] }),
      a: item({ num: 2, title: "Has the cases", plan: [
        { id: "s1", text: "One", state: "done", doneAt: at },
        { id: "c1", card: "c1" },
        { id: "s2", text: "Two", state: "todo" },
        { id: "x1", card: "x1" },
        { id: "s3", text: "Three", state: "todo" },
        { id: "s4", text: "Four", state: "todo", after: ["x1", "s2"] },
        { id: "accept", accept: true, text: "Checked", state: "todo" },
      ] }),
      z: item({ num: 3, title: "Holds the foreign card" }),
    },
    decisions: {
      // has its row; keeps it
      c1: card(4, { confidence: { score: 4, reason: "Measured" } }),
      // no row, ruled in words, written later than c3
      c2: card(5, { at: t2, choice: undefined, ruling: "Decided in chat" }),
      // no row, ruled by option, written first
      c3: card(6, { at: t1 }),
      // no row, still open and blocking: placed before the acceptance step
      c4: card(7, { status: "open", choice: undefined, ruling: undefined, ruledAt: undefined, blocks: "The work stops" }),
      // open, and the owner already sent option B
      c5: card(8, { status: "open", choice: undefined, ruling: undefined, ruledAt: undefined, blocks: "The other work stops" }),
      // belongs to z, ruled; item a waits on it in its plan
      x1: card(9, { item: "z", choice: "B", ruling: undefined }),
    },
    notes: {
      n1: { target: "q:c5", kind: "choice", choice: "B", text: "B", at, state: "sent", sentAt: sent, rev: 1 },
      n2: { target: "q:c4", kind: "comment", text: "Question", at, state: "sent", sentAt: sent, rev: 1 },
    },
  };
}
const withoutUndefined = (input: CardMigrationInput): CardMigrationInput => JSON.parse(JSON.stringify(input));

test("each old card becomes a bare question with option names, old text kept in legacy", () => {
  const { decisions, report } = migrateCards(withoutUndefined(old()), now);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(decisions.c1, { num: 4, item: "a", question: "Which?", options: [{ key: "A", text: "First", recommended: true }, { key: "B", text: "Second" }], status: "ruled", choice: "A", ruledAt: t1, at, updated: at, rev: 1,
    legacy: { background: "Old background", confidence: { score: 4, reason: "Measured" }, ruling: "Old ruling" } });
  assert.equal(decisions.c2!.choice, undefined, "a card ruled in words stays ruled without a choice");
  assert.equal((decisions.c2!.legacy as { ruling: string }).ruling, "Decided in chat");
  for (const doc of Object.values(decisions)) assert.deepEqual(Object.keys(doc).filter(k => ["background", "confidence", "ruling", "order"].includes(k)), []);
  assert.equal(report.cardsOpen + report.cardsRuled, 6);
  assert.equal(report.ruledWithoutChoice, 1);
  for (const [key, doc] of Object.entries(decisions)) assert.ok(Decision.safeParse(doc).success, `${key} passes the current schema`);
});

test("an open card the owner already answered closes with that pick and the send time", () => {
  const { decisions, report } = migrateCards(withoutUndefined(old()), now);
  assert.deepEqual(report.closedFromNote, ["c5"]);
  assert.equal(decisions.c5!.status, "ruled");
  assert.equal(decisions.c5!.choice, "B");
  assert.equal(decisions.c5!.ruledAt, sent);
  assert.equal(decisions.c5!.updated, sent);
  assert.equal(decisions.c4!.status, "open", "a comment on an open card does not rule it");
});

test("cards without a row get one: ruled at the end in the order they were written, open before the acceptance step", () => {
  const { items, report } = migrateCards(withoutUndefined(old()), now);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(items.a!.plan, [
    { id: "s1", text: "One", state: "done", doneAt: at },
    { id: "c1", card: "c1" },
    { id: "s2", text: "Two", state: "todo" },
    // the row after the dropped foreign row was ready because that row was resolved; it stays ready
    { id: "s3", text: "Three", state: "todo", after: [] },
    { id: "s4", text: "Four", state: "todo", after: ["s2"] },
    // an open card is a step the acceptance step also waits for
    { id: "c4", card: "c4", after: [] },
    { id: "accept", accept: true, text: "Checked", state: "todo", after: ["s4", "c4"] },
    { id: "c5", card: "c5" },
    { id: "c3", card: "c3" },
    { id: "c2", card: "c2" },
  ]);
  assert.deepEqual(report.openCardsPlaced, ["c4"]);
  assert.equal(report.rowsAppended, 4, "c5, c3, c2 in a; x1 in z, its own item");
  assert.equal(report.foreignRowsDropped, 1);
  assert.equal(report.afterListsEdited, 1);
  assert.equal(report.successorsReleased, 1);
  assert.deepEqual(items.z!.plan.at(-1), { id: "x1", card: "x1" });
  assert.equal(items.r, undefined, "an item with nothing to change is not written");
});

test("a dropped foreign row leaves a log entry naming the card and what was chosen", () => {
  const { items } = migrateCards(withoutUndefined(old()), now);
  const entry = (items.a!.log as Array<{ at: string; by: string; text: string }>).at(-1)!;
  assert.equal(entry.at, now);
  assert.equal(entry.by, "wf-board");
  assert.match(entry.text, /\[\[q:x1\]\]/);
  assert.match(entry.text, /\[\[it:z\]\]/);
  assert.match(entry.text, /选 B：Second/);
});

test("no status, priority or ready row changes except where an answered card closes or an open card is placed", () => {
  const { report } = migrateCards(withoutUndefined(old()), now);
  // c5 had no row, so closing it moves nothing; c4 is new to the plan and does not change what was ready before.
  assert.deepEqual(report.derivedChanges, []);
});

test("it refuses what it cannot place without a decision", () => {
  const unknown = withoutUndefined(old()); unknown.decisions.c1!.extra = 1;
  assert.match(migrateCards(unknown, now).report.errors.join("\n"), /card c1: unexpected field extra/);
  const openForeign = withoutUndefined(old()); openForeign.decisions.x1!.status = "open"; delete openForeign.decisions.x1!.choice;
  assert.match(migrateCards(openForeign, now).report.errors.join("\n"), /item a: row x1 waits on the open card x1 of item z; place it by hand/);
  const noItem = withoutUndefined(old()); noItem.decisions.c1!.item = "missing";
  assert.match(migrateCards(noItem, now).report.errors.join("\n"), /card c1: its item missing does not exist/);
  const odd = withoutUndefined(old()); odd.decisions.c1!.status = "withtree";
  assert.match(migrateCards(odd, now).report.errors.join("\n"), /card c1: status withtree/);
  const clash = withoutUndefined(old()); (clash.items.a!.plan as Array<Record<string, unknown>>).push({ id: "c2", text: "Taken", state: "todo" });
  assert.match(migrateCards(clash, now).report.errors.join("\n"), /item a: the plan already has a row with the id c2/);
});

test("written through the store in one commit that is not work on the items; the board then opens and the migration refuses to run again", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-migrate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = withoutUndefined(old());
  await writeFile(join(dir, "board.yaml"), stringify(input.board));
  await writeFile(join(dir, "numbers.yaml"), stringify({ next: 10 }));
  for (const [collection, docs] of [["items", input.items], ["decisions", input.decisions], ["notes", input.notes]] as const) {
    await mkdir(join(dir, collection));
    for (const [key, doc] of Object.entries(docs)) await writeFile(join(dir, collection, `${key}.yaml`), stringify(doc));
  }
  const git = async (...args: string[]) => (await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir })).stdout.trim();
  await git("init", "-q", "-b", "main"); await git("add", "."); await git("commit", "-q", "-m", "Old shapes");
  const cursor = await git("rev-parse", "HEAD");
  await assert.rejects(Store.open(dir), /decisions\/c1\.yaml/, "the current schemas refuse the old cards");

  const raw = await readRawCardData(dir), result = migrateCards(raw, now);
  assert.deepEqual(result.report.errors, []);
  const head = await Store.commitCardMigration(dir, raw, result, "wf-board");
  assert.equal(await git("rev-parse", "HEAD"), head);
  assert.equal(await git("rev-list", "--count", "HEAD"), "2", "one commit");
  assert.equal(await git("log", "-1", "--format=%s"), CARD_MIGRATION_MESSAGE);
  assert.deepEqual((await git("show", "--name-only", "--format=", "HEAD")).split("\n").sort(), ["decisions/c1.yaml", "decisions/c2.yaml", "decisions/c3.yaml", "decisions/c4.yaml", "decisions/c5.yaml", "decisions/x1.yaml", "items/a.yaml", "items/z.yaml"].sort());

  const store = await Store.open(dir);
  const snapshot = store.snapshot();
  assert.equal(snapshot.decisions.c5!.status, "ruled");
  assert.equal(snapshot.decisions.c1!.num, 4, "numbers stay");
  assert.equal(snapshot.items.a!.plan.length, 10);
  assert.equal(snapshot.items.z!.plan.length, 2);
  assert.equal(parse(await readFile(join(dir, "numbers.yaml"), "utf8")).next, 10);
  // The owner's unread list does not count the migration.
  assert.deepEqual(await unreadSteps(store, cursor), []);

  await assert.rejects(async () => { const again = migrateCards(await readRawCardData(dir), now); if (again.report.errors.length) throw new Error(again.report.errors.join("\n")); }, /unexpected field legacy/);
});
