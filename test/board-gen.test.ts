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
  assert.ok(s.items[s.decisions[gen.witness.commentCard]!.item]!.plan.some(row => "card" in row && row.card === gen.witness.commentCard), "the comment card is a row of its item's plan");
  assert.ok(placed(gen.witness.commentCard) && placed(gen.witness.multiPlanCard), "the witnesses the page shows inside the head are placed there");
  assert.equal(placed(gen.witness.otherPlanCard), false, "this witness is the card the head does not place");
  assert.equal(s.decisions[gen.witness.proseCard]!.choice, undefined);
  assert.equal(s.decisions[gen.witness.withdrawnCard]!.status, "withdrawn");
  // Every card is a row of its own item's plan and no plan names another item's card.
  for (const [key, card] of Object.entries(s.decisions)) assert.ok(s.items[card.item]!.plan.some(row => "card" in row && row.card === key), `card ${key} has its row`);
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
