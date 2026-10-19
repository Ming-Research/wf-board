// Shared and incremental derivation give exactly what a from-scratch derivation gives (docs/design.md, performance):
// the store's shared Rules objects and their activity index, ops' candidate rules, the page's activity deltas and the
// page's affected-item walk, checked after every write of a seeded random sequence over a synthetic board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Store } from "../src/store.ts";
import type { Change, Put } from "../src/store.ts";
import { ops, OpError } from "../src/ops.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { rules, rebuiltBecause, answersFor, ActivityIndex, DerivedCache, applyActivityDelta, affectedItems, changeSeeds, presentationSignature, sameStatus, STATUS_FIELDS, STALLED_LABEL } from "../src/rules.ts";
import type { Rules } from "../src/rules.ts";
import type { Item, Snapshot } from "../src/model.ts";
import { architect, asArchitect, board, author, at } from "./helpers.ts";

const MINUTE = 60_000;
/** Deterministic, so a failure replays. */
function random(seed: number) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** What a reader sees of each item: the values the board derives and the page paints. */
function derivedView(r: Rules, s: Snapshot): unknown {
  return Object.keys(s.items).map(id => [id, r.statusOf(id), r.checks(id), r.checks(id).some(c => c.label === STALLED_LABEL), r.stalledBelow(id)]);
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
  // 缺难度 depends on what an unpaused root needs, so the board mixes rated and unrated items: the middle layer is rated, the
  // first grandchild of each too. The third root of each project waits on a rated item of the other project that owns an
  // unrated one: the only change pausing it makes there is whether that item is needed, which no check of the rated item shows.
  for (const group of projects) {
    const dep = `${group[0]}dep`, stamp = iso(start), work = { id: "w", text: "step w", state: "todo" }, accept = { id: "accept", text: "passes", state: "todo", accept: true };
    puts.push({ kind: "item", id: dep, expectRev: null, doc: { title: `Item ${dep}`, group, difficulty: 2, plan: [{ id: `${dep}-leaf`, item: `${dep}-leaf`, own: true }, work, accept], created: stamp, updated: stamp, log: [] } });
    puts.push({ kind: "item", id: `${dep}-leaf`, expectRev: null, doc: { title: `Item ${dep}-leaf`, group, plan: [work, accept], created: stamp, updated: stamp, log: [] } });
  }
  for (const group of projects) {
    for (let r = 0; r < 3; r++) {
      const root = `${group[0]}${r}`, children: string[] = [], waitsOn = `${projects.find(name => name !== group)![0]}dep`;
      for (let c = 0; c < 3; c++) {
        const child = `${root}-${c}`, grand = Array.from({ length: Math.floor(rand() * 3) }, (_, g) => `${child}-${g}`);
        for (const id of grand) puts.push({ kind: "item", id, expectRev: null, doc: { title: `Item ${id}`, group, ...(id.endsWith("-0") ? { difficulty: 2 } : {}), plan: [step("w"), { id: "accept", text: "passes", state: "todo", accept: true }], created: tick(), updated: tick(), log: [{ at: tick(), text: "made" }] } });
        puts.push({ kind: "item", id: child, expectRev: null, doc: { title: `Item ${child}`, group, difficulty: 2, plan: [...grand.map(id => ({ id, item: id, own: true })), step("w"), { id: "accept", text: "passes", state: "todo", accept: true }], created: tick(), updated: tick(), log: [] } });
        children.push(child);
      }
      puts.push({ kind: "item", id: root, expectRev: null, doc: { title: `Root ${root}`, group, plan: [...children.map(id => ({ id, item: id, own: true })), ...(r === 2 ? [{ id: waitsOn, item: waitsOn, own: false }] : []), step("w"), { id: "accept", text: "passes", state: "todo", accept: true }], created: tick(), updated: tick(), log: [] } });
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
  const initial = store.snapshot();
  // The page's copy of the activity, kept only from event deltas.
  let page = store.snapshot(), pageActivity = page.activity, pageHead = page.head;
  let previous = store.snapshot(), handled = 0, smaller = 0, compared = 0, sectionMoves = 0;
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
      return op.writeCard({ author: group, key, item: id, kind: "design", question: "Which?", confidence: { reason: "guess" }, options: [{ text: "a", detail: "does a", recommended: true }, { text: "b", detail: "does b" }], ...(rand() < 0.5 ? { blocks: "work stops" } : {}) });
    },
    async s => {
      const open = Object.entries(s.decisions).filter(([, d]) => d.status === "open");
      if (!open.length) return;
      const [key, card] = pick(open), group = s.items[card.item]!.group, action = rand();
      // A revision keeps the card's item and row; a ruling or a withdrawal resolves the row.
      if (action < 0.4) return op.writeCard({ author: group, key, rev: card.rev, item: card.item, question: "Which now?", options: card.options.map(o => ({ text: o.text, detail: o.detail ?? "detail", ...(o.recommended ? { recommended: true } : {}) })) });
      if (action < 0.8) return op.ruleCard({ author: group, key, choice: "A" });
      return op.withdrawCard({ author: group, key, log: "not needed" });
    },
    async s => { const id = pick(itemsOf(s)); return op.setPause({ ...asArchitect, id, paused: !s.items[id]!.paused, ...(s.items[id]!.paused ? {} : { reason: "wait" }) }); },
    async s => {
      const cards = Object.keys(s.decisions);
      const target = cards.length && rand() < 0.5 ? `q:${pick(cards)}` : `it:${pick(itemsOf(s))}`;
      await owner.createNote({ target, kind: target.startsWith("q:") ? "choice" : "comment", text: "note", ...(target.startsWith("q:") ? { choice: "A" } : {}) });
    },
    // A session started on an item, and one ended: an unfinished dispatch holds the item while its session is within the window.
    // Half of them started seven hours ago: the session's next write anywhere brings the item back inside the window.
    async s => { const id = pick(itemsOf(s)); return op.dispatchStart({ ...asArchitect, id, role: pick(["工程师", "审查"] as const), level: 2, model: "Sonnet", agent: pick(["session-a", "session-b", "session-c"]), agentId: `d${made++}`, ...(rand() < 0.5 ? { startedAt: iso(now() - 7 * 60 * MINUTE) } : {}) }); },
    async s => {
      const open = Object.entries(s.items).flatMap(([id, it]) => (it.dispatches ?? []).filter(d => !d.finish).map(d => ({ id, d })));
      if (!open.length) return;
      const { id, d } = pick(open), usage = { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 };
      return op.dispatchFinish({ ...asArchitect, id, agentId: d.agentId, result: "一次通过", usage, cost: 0, ...(d.role === "工程师" ? { reports: 0, kickbacks: 0 } : { rounds: 1 }) });
    },
    async () => owner.send({}),
    async s => { const group = pick(["Whitefoot", "Firn"]), ids = itemsOf(s, group).filter(() => rand() < 0.3); if (ids.length) return op.setTagsMany({ author: group, items: ids.map(id => ({ id, tags: [pick(["健全性", "报错信息"])] })) }); },
    async () => op.setTerm({ author: "Firn", term: `词${made++}`, definition: "意思" }),
  ];
  // The first rounds pause and resume the two roots that wait on the other project's rated item, whatever the seed draws later:
  // nothing below them changes except whether it is needed, which only 缺难度 on an unrated item shows.
  const forced = ["W2", "F2"].flatMap(id => [true, false].map(paused => async (s: Snapshot) => op.setPause({ ...asArchitect, id, paused, ...(paused ? { reason: "wait" } : {}) }) ));
  // The last round is two writes by one session to one item in a row, which the random draws rarely make: an index that kept
  // the item twice would show only then.
  const tailItem = "W0";
  const tail = async (s: Snapshot) => {
    const group = s.items[tailItem]!.group;
    await base.appendLog({ author: group, session: "session-a", id: tailItem, text: "again" });
    return base.appendLog({ author: group, session: "session-a", id: tailItem, text: "and again" });
  };
  for (let round = 0; round < 140; round++) {
    try { await (forced[round] ?? (round === 139 ? tail : pick(actions)))(store.snapshot()); }
    catch (error) { if (!(error instanceof OpError)) throw error; }
    if (moveRand() < 0.25) {
      const s = store.snapshot(), ids = itemsOf(s), id = ids[Math.floor(moveRand() * ids.length)]!, group = s.items[id]!.group;
      try {
        await mover.moveItemProject({ ...asArchitect, id, project: group === "Whitefoot" ? "Firn" : "Whitefoot" });
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
    // The last two are after the six-hour window of a session started in the sequence has passed.
    for (const at of [synthetic, synthetic - 37 * MINUTE, Date.now() + 60 * MINUTE, synthetic + 7 * 60 * MINUTE, Date.now() + 8 * 60 * MINUTE]) {
      const expected = derivedView(rules(after, at), after);
      // The shared rules of a published state may be built from those of the state before it, and then answer for the time
      // those answered for, in the same minute (docs/design.md, section 4, Write cost). This sequence's clock runs a day behind
      // the real one the writes' own reads use, so it seldom happens here; the next test counts it.
      const shared = store.derived.rules(after, at), answered = answersFor(shared)!;
      assert.equal(Math.floor(answered / MINUTE), Math.floor(at / MINUTE), `the shared rules after ${change.message} answer for a time in the minute asked for`);
      assert.deepEqual(derivedView(shared, after), derivedView(rules(after, answered), after), `shared rules after ${change.message}`);
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
      return (id: string) => JSON.stringify([!/^(done|cancelled)$/.test(r.statusOf(id) ?? "") || open.has(id)]);
    };
    // Whether a top-level item sits under its project's 被其他项目依赖 line: an open item of another project depends on it.
    const underRule = (r: Rules, s: Snapshot) => (id: string) => !r.parentOf(id) && r.dependents(id).some(w => !/^(done|cancelled)$/.test(r.statusOf(w.id) ?? "") && s.items[w.id]?.group !== s.items[id]?.group);
    const shownBefore = shown(rb, before), shownAfter = shown(ra, after), underBefore = underRule(rb, before), underAfter = underRule(ra, after);
    for (const id of new Set([...Object.keys(before.items), ...Object.keys(after.items)])) {
      const moved = underBefore(id) !== underAfter(id);
      if (moved) sectionMoves++;
      const changed = presentationSignature(rb, before.decisions, id) !== presentationSignature(ra, after.decisions, id) || shownBefore(id) !== shownAfter(id) || moved;
      if (changed) assert.ok(affected.has(id), `${id} changed after ${change.message} but is not among the affected items`);
    }
    compared++;
    if (affected.size < Object.keys(after.items).length / 2) smaller++;
    }
    handled = events.length;
  }
  // The agent index (src/agents.ts): each session's two most recently touched distinct items, read off the commits by
  // scanning back from the newest until two are found, not by advancing a list as the store does.
  const sessionOf = new Map((await store.log()).map(c => [c.commit, c.session] as const));
  const touchedBy = (i: number): string[] => {
    const here = events[i]!, was = i ? events[i - 1]!.after : initial, items = new Set<string>();
    for (const doc of here.change.changed) {
      if (doc.kind === "item") items.add(doc.id);
      for (const side of [doc.before, doc.after] as Array<Record<string, unknown> | null>) {
        if (!side) continue;
        if (doc.kind === "decision") items.add(side.item as string);
        if (doc.kind === "note" && typeof side.target === "string") {
          const card = side.target.startsWith("q:") ? (here.after.decisions[side.target.slice(2)] ?? was.decisions[side.target.slice(2)]) : undefined;
          if (side.target.startsWith("it:")) items.add(side.target.slice(3)); else if (card) items.add(card.item);
        }
      }
    }
    return [...items].sort();
  };
  const expectedAgents: Record<string, Array<{ item: string; at: string }>> = {};
  for (const session of new Set([...sessionOf.values()].filter((v): v is string => !!v))) {
    const found: Array<{ item: string; at: string }> = [];
    for (let i = events.length - 1; i >= 0 && found.length < 2; i--) {
      if (sessionOf.get(events[i]!.change.commit) !== session) continue;
      for (const item of touchedBy(i)) if (found.length < 2 && !found.some(f => f.item === item)) found.push({ item, at: events[i]!.change.at });
    }
    if (found.length) expectedAgents[session] = found;
  }
  assert.deepEqual(store.snapshot().activity?.agents, expectedAgents, "the agent index equals the two latest items each session touched");
  assert.deepEqual(Object.keys(expectedAgents).sort(), ["session-a", "session-b", "session-c", "架构师"], "every session wrote, the architect's writes under its own name");
  assert.ok(Object.values(expectedAgents).every(list => list.length === 2), "each kept two items");
  assert.equal(expectedAgents["session-a"]![0]!.item, tailItem, "the closing double write by one session to one item happened"); 
  const attributed = Object.keys(store.snapshot().activity?.sessions ?? {}).length;
  assert.ok(attributed > 10, `enough items attributed to a session (${attributed})`);
  // A daemon restart derives the whole activity, session attribution included, from history alone.
  assert.deepEqual((await Store.open(dir)).snapshot().activity, store.snapshot().activity, "activity rebuilt from history equals the incremental one");
  assert.ok(projectMoves > 2, `the random sequence moved items to another project (${projectMoves})`);
  assert.ok(compared > 60, `enough writes compared (${compared})`);
  assert.ok(sectionMoves > 2, `the random sequence moved top-level items between a project's own roots and the roots other projects depend on (${sectionMoves})`);
  assert.ok(smaller > compared / 3, `the walk usually leaves most items unsigned (${smaller} of ${compared})`);
});

test("the shared rules of a published state are built from the state before it, as the daemon's writes and reads come", async t => {
  const rand = random(20261019), { store } = await synthetic(t, rand, Date.now() - 60 * MINUTE);
  // The real clock, as in the daemon: a write's own read of the board and the reads after it fall in the same minute.
  const op = ops(store), events: Snapshot[] = [];
  store.onChange(() => events.push(store.snapshot()));
  const ids = Object.keys(store.snapshot().items), pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const reasons = new Map<string, number>();
  let logs = 0, steps = 0;
  for (let round = 0; round < 60; round++) {
    const id = pick(ids), it = store.snapshot().items[id]!, row = it.plan.find(r => "text" in r && !r.accept) as { id: string; text: string; state: string } | undefined;
    // A log entry changes no field a status reads; a step's state does.
    if (round % 4 === 3 && row) { steps++; await op.setPlan({ author: it.group, id, row: { id: row.id, text: row.text, state: row.state === "doing" ? "done" : "doing" } }); }
    else { logs++; await op.appendLog({ author: it.group, id, text: `entry ${round}` }); }
    const read = Date.now(), after = events.at(-1)!, shared = store.derived.rules(after, read), reason = rebuiltBecause(shared) ?? "reused";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    const answered = answersFor(shared)!;
    assert.equal(Math.floor(answered / MINUTE), Math.floor(read / MINUTE), `the shared rules after round ${round} answer for a time in the minute asked for`);
    assert.deepEqual(derivedView(shared, after), derivedView(rules(after, answered), after), `shared rules after round ${round}`);
  }
  const summary = JSON.stringify(Object.fromEntries(reasons));
  // A minute that turns between a write's read and the next, or the first write's new active time, may rebuild one or two.
  assert.ok((reasons.get("reused") ?? 0) >= logs - 3, `the log writes reused the rules before them: ${summary} (${logs} log writes)`);
  assert.ok((reasons.get("document") ?? 0) >= steps - 3, `a step's state is a field a status reads, so those were rebuilt: ${summary} (${steps})`);
});

test("the affected walk reaches work that a paused root stops needing, past a rated item that shows no change", async t => {
  const { store, op } = await board(t);
  const work = (title: string, group: string, fields: object, rows: object[] = []) => ({ title, group, plan: [...rows, { id: "accept", accept: true, text: "passes", state: "todo" }], updated: at, ...fields });
  // A is another project's item that only R waits on, and is rated, so no check of it moves and nothing pauses it. B, owned by A and not rated, is needed only through R.
  await store.commit({ author: "Fixture", message: "Seed a chain", puts: [
    { kind: "item", id: "r-root", expectRev: null, doc: work("Root", author, { difficulty: 2 }, [{ id: "r-mid", item: "r-mid", own: false }]) },
    { kind: "item", id: "r-mid", expectRev: null, doc: work("Middle", "Firn", { difficulty: 2 }, [{ id: "r-leaf", item: "r-leaf", own: true }]) },
    { kind: "item", id: "r-leaf", expectRev: null, doc: work("Leaf", "Firn", {}) },
  ] });
  const before = store.snapshot();
  await op.setPause({ ...asArchitect, id: "r-root", paused: true, reason: "wait" });
  const after = store.snapshot(), rb = rules(before), ra = rules(after);
  assert.equal(ra.isPaused("r-mid"), false, "nothing pauses the middle item");
  assert.equal(rb.checks("r-leaf").some(c => c.label === "缺难度"), true); assert.equal(ra.checks("r-leaf").some(c => c.label === "缺难度"), false);
  assert.deepEqual(rb.checks("r-mid"), ra.checks("r-mid"), "the rated middle item shows no change");
  assert.notEqual(presentationSignature(rb, before.decisions, "r-leaf"), presentationSignature(ra, after.decisions, "r-leaf"), "the leaf paints differently");
  assert.equal(affectedItems(rb, ra, ["r-root"]).has("r-leaf"), true, "so the page re-signs it now, not at the next full scan");
});

test("the affected walk reaches what an owner's status moves for, though the paused item between them keeps its own", async t => {
  const { store, op } = await board(t);
  const work = (title: string, fields: object, rows: object[] = []) => ({ title, group: author, plan: [...rows, { id: "accept", accept: true, text: "passes", state: "todo" }], updated: at, ...fields });
  // The top item waits on a leaf and owns a paused item, which owns the item that gets its first step done. The paused item
  // stays paused, so its own summary does not move, yet the top item turns from todo to idle because work below it has begun.
  await store.commit({ author: "Fixture", message: "Seed a chain", puts: [
    { kind: "item", id: "b-top", expectRev: null, doc: work("Top", { difficulty: 2 }, [{ id: "ready", text: "ready", state: "todo" }, { id: "b-leaf", item: "b-leaf", own: false }, { id: "b-mid", item: "b-mid", own: true }]) },
    { kind: "item", id: "b-mid", expectRev: null, doc: work("Middle", { difficulty: 2, paused: { reason: "wait", at } }, [{ id: "b-inner", item: "b-inner", own: true }]) },
    { kind: "item", id: "b-inner", expectRev: null, doc: work("Inner", { difficulty: 2 }, [{ id: "step", text: "work", state: "todo" }]) },
    { kind: "item", id: "b-leaf", expectRev: null, doc: work("Leaf", { difficulty: 2 }) },
  ] });
  const before = store.snapshot();
  await op.setPlan({ author, id: "b-inner", row: { id: "step", text: "work", state: "done" } });
  const after = store.snapshot(), rb = rules(before), ra = rules(after);
  assert.deepEqual([rb.statusOf("b-mid"), ra.statusOf("b-mid")], ["paused", "paused"], "the paused item between them keeps its status");
  assert.deepEqual([rb.statusOf("b-top"), ra.statusOf("b-top")], ["todo", "idle"], "the owner's status moves");
  assert.notEqual(presentationSignature(rb, before.decisions, "b-leaf"), presentationSignature(ra, after.decisions, "b-leaf"), "the leaf paints the status of the item waiting on it");
  assert.equal(affectedItems(rb, ra, ["b-inner"]).has("b-leaf"), true, "so the page re-signs it now, not at the next full scan");
});

test("the shared cache holds the state before the newest one and none older, however many writes follow", async t => {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  const { store } = await synthetic(t, random(11), Date.now() - 60 * MINUTE);
  const cache = new DerivedCache(), id = Object.keys(store.snapshot().items)[0]!;
  // Each state is a new object, as each published snapshot is; only the newest is held here, the first only weakly (a copy, since
  // the store holds its own).
  let state: Snapshot = { ...store.snapshot(), items: { ...store.snapshot().items } };
  // The first state has Rules of its own, and each later one is built from the one before: the path a chain would take.
  const at = Date.now(), first = new WeakRef(state), firstRules = new WeakRef(cache.rules(state, at));
  for (let k = 0; k < 6; k++) {
    const next: Snapshot = { ...state, items: { ...state.items } };
    cache.follows(next, state, [{ kind: "item", id }]);
    assert.equal(rebuiltBecause(cache.rules(next, at)), null, `state ${k + 1} reused the rules before it`);
    state = next;
  }
  // A WeakRef keeps its target until the current job ends.
  await new Promise(resolve => setImmediate(resolve));
  collect();
  assert.equal(firstRules.deref(), undefined, "the first state's Rules object was collected: no later one holds it");
  assert.equal(first.deref(), undefined, "the first state was collected: neither the cache's step nor a later Rules object leads back to it");
  assert.ok(cache.rules(state, Date.now()), "the newest state is still served");
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

test("a status is derived from the fields sameStatus compares, and from no others", async t => {
  const { store } = await synthetic(t, random(11), Date.now() - 60 * MINUTE);
  const base = store.snapshot(), read = new Set<string>();
  // Every item is handed to the rules through a proxy that notes each field read from it.
  const watched: Snapshot = { ...base, items: Object.fromEntries(Object.entries(base.items).map(([id, it]) => [id, new Proxy(it, { get: (target, key, receiver) => { if (typeof key === "string") read.add(key); return Reflect.get(target, key, receiver); } })])) };
  const r = rules(watched);
  read.clear();
  for (const id of Object.keys(base.items)) r.statusOf(id);
  assert.deepEqual([...read].sort(), [...STATUS_FIELDS].sort(), "the fields the derivation reads are the listed ones");
  // The predicate: text and log differences do not matter, a field the derivation reads does.
  const item = base.items.W0!;
  const changed = (fields: Partial<Item>): Item => ({ ...item, ...fields });
  assert.equal(sameStatus(item, changed({ head: "another head", title: "another title", log: [...item.log, { at, by: author, text: "more" }], tags: ["健全性"], updated: "2030-01-01T00:00:00Z" })), true);
  assert.equal(sameStatus(item, changed({ plan: item.plan.map(row => "state" in row && row.state === "todo" ? { ...row, state: "done" as const } : row) })), false, "a step's state");
  assert.equal(sameStatus(item, changed({ group: "Firn" })), false, "the project");
  assert.equal(sameStatus(item, changed({ paused: { reason: "wait", at } })), false, "a pause");
  assert.equal(sameStatus(item, changed({ dispatches: [{ agentId: "session-1", agent: "engineer", role: "工程师", level: 2, model: "Sonnet", started: at }] })), false, "a dispatch");
});
