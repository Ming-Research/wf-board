// Marking the rule items standing changes no other item (docs/design.md, section 5, Item plans, Standing items): the comparison of a
// whole board, on a board of the live board's shape, before and after the marks are written through update_item.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ops } from "../src/ops.ts";
import { rules, checkKey } from "../src/rules.ts";
import { boardTags, tagApplies } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { generateBoard } from "./e2e/board-gen.ts";
import { seedBoard, addArchitectProject } from "./e2e/seed.ts";
import { asArchitect } from "./helpers.ts";

/** What a reader of the board sees of every item that the mark must not change: its status, whether it is needed and startable, its checks and what it waits on. */
function seen(s: Snapshot, skip: ReadonlySet<string>) {
  const r = rules(s);
  return Object.fromEntries(Object.keys(s.items).filter(id => !skip.has(id)).map(id => [id, {
    status: r.statusOf(id), paused: r.isPaused(id), open: r.isOpenWork(id), needed: r.isNeeded(id), canStart: r.canStart(id), startable: r.startable(id),
    checks: r.checks(id).map(checkKey), progress: r.progress(id), parent: r.parentOf(id), dependents: r.dependents(id).map(d => d.id).sort(),
  }]));
}

test("marking the rule items standing changes nothing about any other item of a board of the live board's shape", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-standing-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const gen = generateBoard(1);
  const { store } = await seedBoard(dir, gen);
  const op = ops(store, () => new Date().toISOString());
  await addArchitectProject(op, store);
  const s0 = store.snapshot(), group = s0.items[gen.witness.unpaused]!.group;
  // Tags are required of a new item when the vocabulary offers its project one.
  const tag = boardTags(s0.board).find(x => tagApplies(x, group)), tags = tag ? { tags: [tag.name] } : {};
  const make = (key: string, extra: Record<string, unknown> = {}) => op.createItem({ ...asArchitect, key, group, title: key, accept: `${key} holds`, ...tags, ...extra } as Parameters<typeof op.createItem>[0]);
  // The rule root with two blocks, each block's own work done and only its acceptance row left, as the live board has them; and a
  // long-term promise whose work hangs under it and is waited for from another item.
  await make("rule-root");
  for (const key of ["block-a", "block-b"]) {
    await make(key, { owner: "rule-root", after: [] });
    await op.setPlan({ ...asArchitect, id: key, row: { id: "write", text: `Write ${key}`, state: "done" } });
  }
  await make("perf", { difficulty: 2 });
  await make("perf-child", { owner: "perf", after: [], difficulty: 2 });
  await op.setPlan({ ...asArchitect, id: gen.witness.unpaused, row: { item: "perf-child", own: false, after: [] } });
  const marked = new Set(["rule-root", "block-a", "block-b", "perf"]), before = store.snapshot(), beforeSeen = seen(before, marked);
  const was = rules(before);
  // The symptoms the mark removes are really there before it (so the comparison below could fail).
  for (const key of ["block-a", "block-b"]) assert.deepEqual(was.checks(key).map(c => c.id).sort(), ["difficulty-missing", "only-acceptance-left"], key);
  assert.equal(was.isNeeded("perf-child"), true);
  assert.equal(was.canStart("perf-child"), true);

  for (const id of ["rule-root", "block-a", "block-b", "perf"]) await op.updateItem({ ...asArchitect, id, rev: store.snapshot().items[id]!.rev, standing: true });

  const after = store.snapshot(), now = rules(after);
  assert.deepEqual(seen(after, marked), beforeSeen, "no other item's status, checks, need, start or waits changed");
  for (const id of marked) {
    assert.equal(now.statusOf(id), "wip", `${id} is in progress`);
    assert.deepEqual(now.checks(id), [], `${id} has no check`);
    assert.equal(now.isStanding(id), true);
  }
  // The need still goes to the work under the standing promise, which is still ready to start.
  assert.equal(now.isNeeded("perf-child"), true);
  assert.equal(now.canStart("perf-child"), true);
  assert.equal(now.startable("perf-child"), true);
});
