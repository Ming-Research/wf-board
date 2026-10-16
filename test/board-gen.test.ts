import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBoard } from "./e2e/board-gen.ts";
import { seedBoard } from "./e2e/seed.ts";
import { shapeCounts, REQUIRED_SHAPES } from "./e2e/shapes.ts";
import { unreadSteps } from "../src/history.ts";
import { placedCards, rules } from "../src/rules.ts";

// The browser tests (test/e2e) run on this board; these checks keep it valid and keep every real shape in it.
for (const seed of [1, 2]) test(`generated board ${seed}: valid documents, every shape category, read and unread history`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-gen-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const gen = generateBoard(seed);
  assert.deepEqual(generateBoard(seed), gen, "the same seed gives the same board");
  // The store validates every document against the schemas and refuses the commit otherwise.
  const { store } = await seedBoard(dir, gen);
  const s = store.snapshot(), counts = shapeCounts(s);
  const missing = REQUIRED_SHAPES.filter(k => !counts[k]);
  assert.deepEqual(missing, [], "every shape category appears: " + JSON.stringify(counts));
  assert.ok(counts.items! > 100 && counts.items! < 400, "large enough to have structure, small enough for a browser walk: " + counts.items);
  const r = rules(s);
  for (const [name, key] of Object.entries(gen.witness)) assert.ok(s.items[key] || s.decisions[key], `witness ${name} exists`);
  assert.equal(r.cardWaiting(gen.witness.commentCard), true);
  const placed = (key: string) => placedCards(s.items[s.decisions[key]!.item]!.head).includes(key);
  const hasRow = (key: string) => s.items[s.decisions[key]!.item]!.plan.some(row => "card" in row && row.card === key);
  assert.ok(hasRow(gen.witness.multiPlanCard) && hasRow(gen.witness.donePlanCard) && hasRow(gen.witness.rowCard), "a blocking card and a closed card that kept its row have one");
  assert.equal(hasRow(gen.witness.commentCard), false, "the comment card does not block, so it has no row");
  assert.ok(placed(gen.witness.commentCard) && placed(gen.witness.multiPlanCard), "the witnesses the page shows inside the head are placed there");
  assert.ok(placed(gen.witness.legacyCard) && placed(gen.witness.proseCard) && placed(gen.witness.openLegacyCard), "the converted old cards stand in the section at the end of the head");
  assert.equal(placed(gen.witness.otherPlanCard) || hasRow(gen.witness.otherPlanCard), false, "this witness has neither a line in the head nor a row");
  assert.equal(placed(gen.witness.rowCard), false, "this witness has a row but no line in the head");
  assert.deepEqual(s.decisions[gen.witness.legacyCard]!.options.map(o => o.text), s.decisions[gen.witness.legacyCard]!.options.map(() => ""), "converted cards have nameless options");
  assert.equal(s.decisions[gen.witness.proseCard]!.choice, undefined);
  assert.equal(s.decisions[gen.witness.withdrawnCard]!.status, "withdrawn");
  // Only a card that blocks has a row (a closed card may keep the one it had), and no plan names another item's card.
  for (const [key, card] of Object.entries(s.decisions)) if (card.status === "open") assert.equal(hasRow(key), r.cardBlocking(key), `open card ${key} has a row exactly when it blocks`);
  for (const [id, item] of Object.entries(s.items)) for (const row of item.plan) if ("card" in row) assert.equal(s.decisions[row.card]!.item, id, `${id} names only its own cards`);
  assert.deepEqual(Object.keys(s.items).flatMap(id => r.checks(id).filter(c => c.label === "卡和计划对不上").map(c => id)), [], "no card and row disagree");
  assert.equal(r.isPaused(gen.witness.unpaused), false);
  assert.ok(r.isOpenWork(gen.witness.unpaused));
  // The ownership graph is acyclic: every item reaches a top item.
  for (const id of Object.keys(s.items)) assert.ok(r.ancestors(id).length < 20 && !r.onCycle(id), id);
  const steps = await unreadSteps(store, s.owner.cursor, s.owner.readMarks, s.head);
  const docs = new Set(steps.flatMap(step => step.docs.map(d => d.kind + ":" + d.id)));
  assert.ok(docs.size >= 10 && docs.size <= 80, "a walkable number of unread documents: " + docs.size);
  assert.ok([...docs].some(d => d.startsWith("note:")) && [...docs].some(d => d.startsWith("decision:")) && [...docs].some(d => d.startsWith("item:")));
});
