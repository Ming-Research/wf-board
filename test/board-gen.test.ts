import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBoard } from "./e2e/board-gen.ts";
import { seedBoard } from "./e2e/seed.ts";
import { shapeCounts, REQUIRED_SHAPES } from "./e2e/shapes.ts";
import { unreadSteps } from "../src/history.ts";
import { rules } from "../src/rules.ts";

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
  assert.ok(s.items[s.decisions[gen.witness.commentCard]!.item]!.plan.some(row => "card" in row && row.card === gen.witness.commentCard), "the comment card unfolds inline under its home plan row");
  assert.equal(r.isPaused(gen.witness.unpaused), false);
  assert.ok(r.isOpenWork(gen.witness.unpaused));
  // The ownership graph is acyclic: every item reaches a top item.
  for (const id of Object.keys(s.items)) assert.ok(r.ancestors(id).length < 20 && !r.onCycle(id), id);
  const steps = await unreadSteps(store, s.owner.cursor, s.owner.readMarks, s.head);
  const docs = new Set(steps.flatMap(step => step.docs.map(d => d.kind + ":" + d.id)));
  assert.ok(docs.size >= 10 && docs.size <= 80, "a walkable number of unread documents: " + docs.size);
  assert.ok([...docs].some(d => d.startsWith("note:")) && [...docs].some(d => d.startsWith("decision:")) && [...docs].some(d => d.startsWith("item:")));
});

// Item e2e-git-tmp-flake: git's automatic maintenance, left in the background, repacked while the next git add ran.
// Every git commit gets maintenance (gc.auto=1); git's trace2 log shows whether a git add starts during a maintenance run.
test("seeding: automatic maintenance ends before the next git add starts", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-gen-"));
  const traceDir = await mkdtemp(join(tmpdir(), "wf-board-trace-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  t.after(() => rm(traceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const trace = join(traceDir, "trace2.jsonl");
  const env = { GIT_TRACE2_EVENT: trace, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "gc.auto", GIT_CONFIG_VALUE_0: "1" };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  await seedBoard(dir, generateBoard(1));
  // Each line is one trace2 event: start events carry argv, exit events end the process with the same sid.
  type Event = { event: string; sid: string; t_abs: number; argv?: string[] };
  const events = (await readFile(trace, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line) as Event);
  const exitAt = (sid: string, from: number) => events.find(e => e.event === "exit" && e.sid === sid && e.t_abs >= from)?.t_abs ?? Infinity;
  const maintenance = events.filter(e => e.event === "start" && e.argv?.some(a => a === "maintenance" || a === "repack"))
    .map(e => ({ from: e.t_abs, to: exitAt(e.sid, e.t_abs) }));
  const adds = events.filter(e => e.event === "start" && e.argv?.includes("add")).map(e => e.t_abs);
  assert.ok(maintenance.length > 0, "automatic maintenance ran: " + maintenance.length);
  assert.ok(adds.length > 0, "git add ran: " + adds.length);
  const overlaps = adds.filter(a => maintenance.some(m => a >= m.from && a < m.to));
  // Temporary diagnostics (CI showed overlaps with the fix in place): the process events in trace order.
  const trail = events.filter(e => /^(start|exit|child_start|child_exit)$/.test(e.event)).slice(0, 150).map(e => JSON.stringify(e)).join("\n");
  assert.equal(overlaps.length, 0, `no git add starts during a maintenance run; ${overlaps.length} overlaps; maintenance ${JSON.stringify(maintenance)}\n${trail}`);
});
