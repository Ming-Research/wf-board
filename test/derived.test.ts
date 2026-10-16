// Shared and incremental derivation give exactly what a from-scratch derivation gives (docs/design.md, performance):
// the store's shared Rules objects and their activity index, ops' candidate rules, the page's activity deltas and the
// page's affected-item walk, checked after every write of a seeded random sequence over a synthetic board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import type { Change, Put } from "../src/store.ts";
import { ops, OpError } from "../src/ops.ts";
import { architect, asArchitect } from "./helpers.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { rules, ActivityIndex, applyActivityDelta, affectedItems, changeSeeds, presentationSignature, STALLED_LABEL } from "../src/rules.ts";
import type { Rules } from "../src/rules.ts";
import type { Snapshot } from "../src/model.ts";

const MINUTE = 60_000;
/** Deterministic, so a failure replays. */
function random(seed: number) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** What a reader sees of each item: the values the board derives and the page paints. */
function derivedView(r: Rules, s: Snapshot): unknown {
  return Object.keys(s.items).map(id => [id, r.statusOf(id), r.priorityOf(id), r.checks(id), r.checks(id).some(c => c.label === STALLED_LABEL), r.stalledBelow(id)]);
}

async function synthetic(t: { after(fn: () => Promise<void>): void }, rand: () => number, start: number) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-derived-"));
  // git may still be writing objects when the test ends; retry instead of failing on ENOTEMPTY.
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const projects = ["Whitefoot", "Firn"];
  const store = await Store.open(dir, { init: true, board: { title: "Derived", projects: [...projects.map(name => ({ name })), { name: architect }] } });
  const puts: Put[] = [];
  let time = start;
  const tick = () => iso(time += Math.floor(rand() * 5 * MINUTE));
  const state = () => (["todo", "doing", "done"] as const)[Math.floor(rand() * 3)]!;
  const step = (id: string) => { const st = state(), at = tick(); return { id, text: `step ${id}`, state: st, ...(st === "doing" ? { since: at } : st === "done" ? { doneAt: at } : {}) }; };
  for (const group of projects) {
    for (let r = 0; r < 3; r++) {
      const root = `${group[0]}${r}`, children: string[] = [];
      for (let c = 0; c < 3; c++) {
        const child = `${root}-${c}`, grand = Array.from({ length: Math.floor(rand() * 3) }, (_, g) => `${child}-${g}`);
        for (const id of grand) puts.push({ kind: "item", id, expectRev: null, doc: { title: `Item ${id}`, group, plan: [step("w"), { id: "accept", text: "passes", state: "todo", accept: true }], created: tick(), updated: tick(), log: [{ at: tick(), text: "made" }] } });
        puts.push({ kind: "item", id: child, expectRev: null, doc: { title: `Item ${child}`, group, plan: [...grand.map(id => ({ id, item: id, own: true })), step("w"), { id: "accept", text: "passes", state: "todo", accept: true }], created: tick(), updated: tick(), log: [] } });
        children.push(child);
      }
      puts.push({ kind: "item", id: root, expectRev: null, doc: { title: `Root ${root}`, group, priority: (["P0", "P1", "P2"] as const)[r]!, plan: [...children.map(id => ({ id, item: id, own: true })), step("w"), { id: "accept", text: "passes", state: "todo", accept: true }], created: tick(), updated: tick(), log: [] } });
    }
  }
  await store.commit({ author: "Fixture", message: "Seed", puts });
  return { dir, store, now: () => time, tick, advance: () => { time += Math.floor(1 + rand() * 8 * MINUTE); return iso(time); } };
}

test("shared and incremental derivation equal a from-scratch derivation after every write", async t => {
  const rand = random(20261013), start = Date.now() - 24 * 60 * MINUTE;
  const { dir, store, now, advance } = await synthetic(t, rand, start);
  const base = ops(store, advance), owner = ownerOps(store, advance);
  // Moves to another project come from their own stream and their own clock (the current synthetic time), so they take nothing
  // from the random sequence or the clock the other actions draw on.
  const mover = ops(store, () => iso(now())), moveRand = random(20261016);
  let projectMoves = 0;
  // Most writes name one of three sessions, some none (an older client): the session attribution then has to follow the
  // same incremental and from-history derivations as the activity times.
  const op = new Proxy(base, { get: (target, name) => {
    const fn = target[name as keyof typeof target] as (a: object) => Promise<unknown>;
    return (a: object) => { const session = [undefined, "session-a", "session-b", "session-c"][Math.floor(rand() * 4)]; return fn.call(target, session ? { session, ...a } : a); };
  } }) as typeof base;
  await op.setTag({ ...asArchitect, name: "健全性", meaning: "影响接受或拒绝" });
  await op.setTag({ ...asArchitect, name: "报错信息", meaning: "影响诊断措辞" });
  // Each commit with the snapshot it published, taken when the store announces it.
  const events: Array<{ change: Change; after: Snapshot }> = [];
  store.onChange(change => events.push({ change, after: store.snapshot() }));
  // The page's copy of the activity, kept only from event deltas.
  let page = store.snapshot(), pageActivity = page.activity, pageHead = page.head;
  let previous = store.snapshot(), handled = 0, smaller = 0, compared = 0;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const itemsOf = (s: Snapshot, group?: string) => Object.keys(s.items).filter(id => !group || s.items[id]!.group === group);
  let made = 0;
  const actions: Array<(s: Snapshot) => Promise<unknown>> = [
    async s => { const id = pick(itemsOf(s)); return op.appendLog({ author: s.items[id]!.group, id, text: "progress" }); },
    async s => {
      const id = pick(itemsOf(s)), it = s.items[id]!, steps = it.plan.filter(row => "text" in row && !row.accept);
      if (!steps.length) return;
      const row = pick(steps) as { id: string; text: string }, st = pick(["todo", "doing", "done"] as const);
      // Some step texts name another item: a doing step's clock then reads that item's changes too.
      const text = rand() < 0.4 ? `${row.text} [[it:${pick(itemsOf(s))}]]` : row.text;
      return op.setPlan({ author: it.group, id, row: { id: row.id, text, state: st } });
    },
    async s => { const id = pick(itemsOf(s)), other = pick(itemsOf(s)); return op.setPlan({ author: s.items[id]!.group, id, row: { item: other, own: false } }); },
    async s => {
      const id = pick(itemsOf(s)), it = s.items[id]!, shared = it.plan.filter(row => "item" in row && !row.own);
      if (shared.length) return op.setPlan({ author: it.group, id, remove: pick(shared).id });
    },
    async s => { const owner = pick(itemsOf(s)), key = `n${made++}`; return op.createItem({ ...asArchitect, key, owner, title: `New ${key}`, accept: "passes", plan: [{ id: "w", text: "work", state: pick(["todo", "doing"] as const) }], tags: ["健全性"] }); },
    async s => { const id = pick(itemsOf(s)), group = s.items[id]!.group, to = pick(itemsOf(s, group)); return op.moveItem({ author: group, id, owner: to }); },
    async s => { const id = pick(itemsOf(s)), it = s.items[id]!; return op.setStatus({ ...asArchitect, id, status: it.status === "cancelled" ? "open" : "cancelled", log: "because" }); },
    async s => {
      // The card's row joins its item's plan in the same commit; the item then waits for it while it is open.
      const id = pick(itemsOf(s)), key = `c${made++}`, group = s.items[id]!.group;
      return op.writeCard({ author: group, key, item: id, question: "Which?", options: [{ text: "a", recommended: true }, { text: "b" }], ...(rand() < 0.5 ? { blocks: "work stops" } : {}) });
    },
    async s => {
      const open = Object.entries(s.decisions).filter(([, d]) => d.status === "open");
      if (!open.length) return;
      const [key, card] = pick(open), group = s.items[card.item]!.group, action = rand();
      // A revision keeps the card's item and row; a ruling or a withdrawal resolves the row.
      if (action < 0.4) return op.writeCard({ author: group, key, rev: card.rev, item: card.item, question: "Which now?", options: card.options.map(({ key: _key, ...option }) => option) });
      if (action < 0.8) return op.ruleCard({ author: group, key, choice: "A" });
      return op.withdrawCard({ author: group, key, log: "not needed" });
    },
    async s => { const id = pick(itemsOf(s)); return op.setPause({ ...asArchitect, id, paused: !s.items[id]!.paused, ...(s.items[id]!.paused ? {} : { reason: "wait" }) }); },
    async s => {
      const cards = Object.keys(s.decisions);
      const target = cards.length && rand() < 0.5 ? `q:${pick(cards)}` : `it:${pick(itemsOf(s))}`;
      await owner.createNote({ target, kind: target.startsWith("q:") ? "choice" : "comment", text: "note", ...(target.startsWith("q:") ? { choice: "A" } : {}) });
    },
    async () => owner.send({}),
    async s => { const group = pick(["Whitefoot", "Firn"]), ids = itemsOf(s, group).filter(() => rand() < 0.3); if (ids.length) return op.setTagsMany({ author: group, items: ids.map(id => ({ id, tags: [pick(["健全性", "报错信息"])] })) }); },
    async () => op.setTerm({ author: "Firn", term: `词${made++}`, definition: "意思" }),
  ];
  for (let round = 0; round < 140; round++) {
    try { await pick(actions)(store.snapshot()); }
    catch (error) { if (!(error instanceof OpError)) throw error; }
    if (moveRand() < 0.25) {
      const s = store.snapshot(), ids = itemsOf(s), id = ids[Math.floor(moveRand() * ids.length)]!, group = s.items[id]!.group;
      try {
        await mover.moveItemProject({ ...asArchitect, id, project: group === "Whitefoot" ? "Firn" : "Whitefoot", ...(moveRand() < 0.5 ? { priority: (["P0", "P1", "P2"] as const)[Math.floor(moveRand() * 3)]! } : {}) });
        projectMoves++;
      } catch (error) { if (!(error instanceof OpError)) throw error; }
    }
    for (const { change, after } of events.slice(handled)) {
    const before = previous;
    previous = after;

    // The page's activity, kept from deltas alone, stays equal to the store's.
    assert.equal(change.activity.from, pageHead);
    pageActivity = applyActivityDelta(pageActivity, change.activity); pageHead = change.commit;
    assert.deepEqual(pageActivity, after.activity, `page activity after ${change.message}`);
    page = { ...after, activity: pageActivity };

    // Shared rules (store.derived, with the advanced activity index), candidate rules and the page's equal a fresh scan.
    const synthetic = now();
    for (const at of [synthetic, synthetic - 37 * MINUTE, Date.now() + 60 * MINUTE]) {
      const expected = derivedView(rules(after, at), after);
      assert.deepEqual(derivedView(store.derived.rules(after, at), after), expected, `shared rules after ${change.message}`);
      assert.deepEqual(derivedView(store.derived.candidate(before, after, at), after), expected, `candidate rules after ${change.message}`);
      assert.deepEqual(derivedView(rules(page, at, { activity: ActivityIndex.build(page) }), page), expected, `page rules after ${change.message}`);
      const index = store.derived.activity(after), built = ActivityIndex.build(after);
      assert.deepEqual(index.intervals(at), built.intervals(at));
      for (const id of [...Object.keys(after.items), ...Object.keys(before.items)]) assert.equal(index.changedAt(id, at), built.changedAt(id, at), `changedAt ${id}`);
    }

    // Every item whose painted presentation changed is among the affected items the page re-signs.
    const rb = rules(before, synthetic), ra = rules(after, synthetic);
    const seeds = changeSeeds(before, after, rb, ra, change.changed, change.activity);
    if (!seeds) { assert.ok(change.changed.some(doc => ["board", "owner", "glossary"].includes(doc.kind)), "only board, owner and glossary changes re-sign everything"); continue; }
    const affected = affectedItems(rb, ra, seeds);
    const shown = (r: Rules, s: Snapshot) => {
      const ids = Object.keys(s.items), open = new Set(ids.filter(id => r.isOpenWork(id)).flatMap(id => r.ancestors(id)));
      return (id: string) => JSON.stringify([!/^(done|cancelled)$/.test(r.statusOf(id) ?? "") || open.has(id), r.isRequest(id)]);
    };
    const shownBefore = shown(rb, before), shownAfter = shown(ra, after);
    for (const id of new Set([...Object.keys(before.items), ...Object.keys(after.items)])) {
      const changed = presentationSignature(rb, before.decisions, id) !== presentationSignature(ra, after.decisions, id) || shownBefore(id) !== shownAfter(id);
      if (changed) assert.ok(affected.has(id), `${id} changed after ${change.message} but is not among the affected items`);
    }
    compared++;
    if (affected.size < Object.keys(after.items).length / 2) smaller++;
    }
    handled = events.length;
  }
  const attributed = Object.keys(store.snapshot().activity?.sessions ?? {}).length;
  assert.ok(attributed > 10, `enough items attributed to a session (${attributed})`);
  // A daemon restart derives the whole activity, session attribution included, from history alone.
  assert.deepEqual((await Store.open(dir)).snapshot().activity, store.snapshot().activity, "activity rebuilt from history equals the incremental one");
  assert.ok(projectMoves > 2, `the random sequence moved items to another project (${projectMoves})`);
  assert.ok(compared > 60, `enough writes compared (${compared})`);
  assert.ok(smaller > compared / 3, `the walk usually leaves most items unsigned (${smaller} of ${compared})`);
});

test("one Rules object per snapshot and minute is shared, and a write or a new minute makes another", async t => {
  const rand = random(7), { store } = await synthetic(t, rand, Date.now() - 60 * MINUTE);
  const s = store.snapshot(), at = Math.floor(Date.now() / MINUTE) * MINUTE;
  const first = store.derived.rules(s, at + 1000);
  assert.strictEqual(store.derived.rules(s, at + 59_000), first, "the same minute reuses it");
  assert.notStrictEqual(store.derived.rules(s, at + MINUTE), first, "a new minute builds another");
  await ops(store).appendLog({ author: "Whitefoot", id: "W0", text: "more" });
  assert.notStrictEqual(store.derived.rules(store.snapshot(), at + 1000), first, "a new snapshot builds another");
});
