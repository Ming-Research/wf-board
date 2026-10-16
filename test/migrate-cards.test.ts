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
        { id: "c6", card: "c6" },
        { id: "accept", accept: true, text: "Checked", state: "todo" },
      ] }),
      z: item({ num: 3, title: "Holds the foreign card", head: "Intro\n\n**参考：R**\n\nreference text" }),
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
      // open and does not block, but has a row: the row goes
      c6: card(10, { status: "open", choice: undefined, ruling: undefined, ruledAt: undefined }),
    },
    notes: {
      n1: { target: "q:c5", kind: "choice", choice: "B", text: "B", at, state: "sent", sentAt: sent, rev: 1 },
      n2: { target: "q:c4", kind: "comment", text: "Question", at, state: "sent", sentAt: sent, rev: 1 },
    },
  };
}
const withoutUndefined = (input: CardMigrationInput): CardMigrationInput => JSON.parse(JSON.stringify(input));

test("each old card becomes a question whose options keep the old text as their detail; confidence and ruling stay, the background goes to legacy", () => {
  const { decisions, report } = migrateCards(withoutUndefined(old()), now);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(decisions.c1, { num: 4, item: "a", question: "Which?", options: [{ key: "A", text: "", detail: "First", recommended: true }, { key: "B", text: "", detail: "Second" }], status: "ruled", choice: "A", ruledAt: t1, at, updated: at, rev: 1,
    confidence: { score: 4, reason: "Measured" }, ruling: "Old ruling", legacy: { background: "Old background" } });
  assert.equal(decisions.c2!.choice, undefined, "a card ruled in words stays ruled without a choice");
  assert.equal(decisions.c2!.ruling, "Decided in chat");
  for (const doc of Object.values(decisions)) assert.deepEqual(Object.keys(doc).filter(k => ["background", "order"].includes(k)), []);
  assert.equal(report.cardsOpen + report.cardsRuled, 7);
  assert.equal(report.ruledWithoutChoice, 1);
  assert.equal(report.legacyKept, 7);
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

test("only a card that blocks has a row: an open blocking one without gets it before the acceptance step, an open one with a row but no blocks blocks the step after its row and keeps it, closed ones get none", () => {
  const { items, decisions, report } = migrateCards(withoutUndefined(old()), now);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(items.a!.plan, [
    { id: "s1", text: "One", state: "done", doneAt: at },
    { id: "c1", card: "c1" },
    { id: "s2", text: "Two", state: "todo" },
    // the row after the dropped foreign row was ready because that row was resolved; it stays ready
    { id: "s3", text: "Three", state: "todo", after: [] },
    { id: "s4", text: "Four", state: "todo", after: ["s2"] },
    // c6 had a row but no blocks: it keeps the row, and the step after it (the acceptance step) is what it blocks
    { id: "c6", card: "c6" },
    // an open blocking card is a step the acceptance step also waits for
    { id: "c4", card: "c4", after: [] },
    { id: "accept", accept: true, text: "Checked", state: "todo", after: ["c6", "c4"] },
  ]);
  assert.deepEqual(report.openCardsPlaced, ["c4"]);
  assert.deepEqual(report.openCardsBlocking, [{ card: "c6", blocks: "Checked" }]);
  assert.equal(decisions.c6!.blocks, "Checked");
  assert.equal(report.foreignRowsDropped, 1);
  assert.equal(report.afterListsEdited, 1);
  assert.equal(report.successorsReleased, 1);
  assert.equal((items.z!.plan as unknown[]).length, 1, "x1 is ruled and gets no row in its own item's plan");
  assert.equal(items.r, undefined, "an item with nothing to change is not written");
});

test("the cards a head does not place get a section at its end, before the 参考 sections, in the order they were written; placed ones keep their line", () => {
  const input = withoutUndefined(old());
  const { items, report } = migrateCards(input, now);
  assert.equal(items.a!.head, "**以前的决定**\n\n[[q:c1]]\n\n[[q:c4]]\n\n[[q:c5]]\n\n[[q:c6]]\n\n[[q:c3]]\n\n[[q:c2]]");
  assert.equal(items.z!.head, "Intro\n\n**以前的决定**\n\n[[q:x1]]\n\n**参考：R**\n\nreference text");
  assert.equal(report.headsExtended, 2); assert.equal(report.cardsPlaced, 7);
  assert.equal(report.headSample, "**以前的决定**\n\n[[q:c1]]\n\n[[q:c4]]\n\n[[q:c5]]\n\n[[q:c6]]\n\n[[q:c3]]\n\n[[q:c2]]");
  input.items.a!.head = "Text\n\n[[q:c3]]\n\nAfter";
  const placed = migrateCards(input, now).items.a!.head as string;
  assert.ok(placed.startsWith("Text\n\n[[q:c3]]\n\nAfter\n\n**以前的决定**\n\n[[q:c1]]"), "the line c3 has stays where it is");
  assert.ok(!placed.slice(placed.indexOf("以前的决定")).includes("[[q:c3]]"), "and is not given a second one");
});

test("an open card with a row but no blocks blocks the row that waits for it, else the row after it, else the work after it; the name is a step's text, an item's title or a card's question", () => {
  const input = withoutUndefined(old());
  const open = (n: number, extra: Record<string, unknown> = {}) => card(n, { item: "m", status: "open", choice: undefined, ruling: undefined, ruledAt: undefined, ...extra });
  input.decisions.k1 = open(20); input.decisions.k2 = open(21); input.decisions.k3 = open(22); input.decisions.k4 = open(23, { question: "**Which\nof two?**" });
  input.items.m = item({ num: 30, title: "Has open cards", plan: [
    { id: "k1", card: "k1" }, { id: "p", text: "Prepare", state: "todo" }, { id: "q", text: "Gated work\nsecond line", state: "todo", after: ["k1"] },
    { id: "k2", card: "k2" }, { id: "z", item: "z", own: false, after: [] },
    { id: "k3", card: "k3", after: [] }, { id: "k4", card: "k4" },
    { id: "accept", accept: true, text: "Checked", state: "todo" },
  ] });
  const { items, decisions, report } = migrateCards(input, now);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.openCardsBlocking.filter(c => c.card.startsWith("k")), [
    { card: "k1", blocks: "Gated work" },
    // a step with no row waiting for the card: the row after it, here an item's title
    { card: "k2", blocks: "Holds the foreign card" },
    // here a card's question, first line, without the bold marks
    { card: "k3", blocks: "Which" },
    { card: "k4", blocks: "Checked" },
  ]);
  assert.equal(decisions.k1!.blocks, "Gated work");
  assert.deepEqual((items.m!.plan as Array<{ id: string }>).map(row => row.id), ["k1", "p", "q", "k2", "z", "k3", "k4", "accept"], "the plan keeps every card row and every step");
  // A card with no row after it names the work after it.
  const last = withoutUndefined(old()); last.decisions.k9 = card(40, { item: "m", status: "open", choice: undefined, ruling: undefined, ruledAt: undefined });
  last.items.m = item({ num: 31, title: "Ends with a card", plan: [{ id: "k9", card: "k9" }] });
  assert.deepEqual(migrateCards(last, now).report.openCardsBlocking.filter(c => c.card === "k9"), [{ card: "k9", blocks: "本条目后面的工作" }]);
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
  const clash = withoutUndefined(old()); (clash.items.a!.plan as Array<Record<string, unknown>>).push({ id: "c4", text: "Taken", state: "todo" });
  assert.match(migrateCards(clash, now).report.errors.join("\n"), /item a: the plan already has a row with the id c4/);
});

test("written through the store in one commit that is not work on the items; the board then opens and the migration refuses to run again", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-migrate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = withoutUndefined(old());
  await writeFile(join(dir, "board.yaml"), stringify(input.board));
  await writeFile(join(dir, "numbers.yaml"), stringify({ next: 11 }));
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
  assert.deepEqual((await git("show", "--name-only", "--format=", "HEAD")).split("\n").sort(), ["decisions/c1.yaml", "decisions/c2.yaml", "decisions/c3.yaml", "decisions/c4.yaml", "decisions/c5.yaml", "decisions/c6.yaml", "decisions/x1.yaml", "items/a.yaml", "items/z.yaml"].sort());

  const store = await Store.open(dir);
  const snapshot = store.snapshot();
  assert.equal(snapshot.decisions.c5!.status, "ruled");
  assert.equal(snapshot.decisions.c1!.num, 4, "numbers stay");
  assert.equal(snapshot.items.a!.plan.length, 8);
  assert.equal(snapshot.items.z!.plan.length, 1);
  assert.equal(parse(await readFile(join(dir, "numbers.yaml"), "utf8")).next, 11);
  // The owner's unread list does not count the migration.
  assert.deepEqual(await unreadSteps(store, cursor), []);

  await assert.rejects(async () => { const again = migrateCards(await readRawCardData(dir), now); if (again.report.errors.length) throw new Error(again.report.errors.join("\n")); }, /unexpected field legacy/);
});
