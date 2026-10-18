// Rules that reuse the Rules object of the state before a write (rules' `previous`, docs/design.md section 4, Write cost) must
// answer exactly what rules derived from nothing answer, for the time they answer for. The oracle is that from-scratch
// derivation, on a generated board of the live board's size after random writes of the kinds sessions make; each refusal to
// reuse has a small board of its own. Each guard is also taken out of a copy of src/rules.ts, where the comparison must fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as current from "../src/rules.ts";
import type { ActivityDelta, Rules } from "../src/rules.ts";
import { Decision, Item } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { generateBoard, prng } from "./e2e/board-gen.ts";
import { seedBoard } from "./e2e/seed.ts";

type RulesModule = Pick<typeof current, "rules" | "rebuiltBecause" | "applyActivityDelta" | "STALLED_LABEL">;
const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();
/** A write's time as the store stamps it: whole seconds, so it can fall before a page's build in the same second. */
const stamp = (ms: number) => new Date(Math.floor(ms / SECOND) * SECOND).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Everything a Rules object answers, for every item and card: two that agree here agree for the page and the server. */
function answers(r: Rules, s: Snapshot): string {
  const ids = Object.keys(s.items).sort();
  return JSON.stringify([r.areas(), [...ids].sort(r.compareCandidates), [...ids].sort(r.compareSiblings),
    Object.keys(s.decisions).sort().map(key => [key, r.cardChecks(key), r.cardWaiting(key), r.cardBlocking(key), r.cardDependents(key)]),
    ids.map(id => [id, r.item(id), r.statusOf(id), r.checks(id), r.refusals(id), r.planRows(id), r.planGroups(id), r.planRatio(id), r.progressShare(id),
      r.planRows(id).map(row => "text" in row.row ? r.stepLine(row.row) : null), r.depsOf(id), r.dependents(id), r.isNeeded(id),
      r.canStart(id), r.startable(id), r.progress(id), r.stalledBelow(id), r.blockingBelow(id), r.nonBlockingBelow(id), r.pausedBy(id),
      r.isPaused(id), r.isOpenWork(id), r.isRoot(id), r.isBacklog(id), r.isLeaf(id), r.children(id), r.ancestors(id), r.lineOf(id),
      r.groupOf(id), r.onCycle(id), r.needsOwner(id), r.ownerBlocking(id), r.askPending(id), r.workedOn(id), r.begun(id),
      r.openDependents(id), r.mentionedBy(id), r.cardsOf(id), r.parentOf(id)])]);
}
/** Only the checks and the stalled counts: what the guards taken out in the copies leave wrong. */
function checksOnly(r: Rules, s: Snapshot): string {
  return JSON.stringify(Object.keys(s.items).sort().map(id => [id, r.checks(id), r.stalledBelow(id)]));
}

/** src/rules.ts with `edits` applied, loaded as a module of its own; each edit must match exactly once. */
async function variant(t: { after(fn: () => unknown): void }, edits: Array<[string, string]>): Promise<RulesModule> {
  const src = join(import.meta.dirname, "../src"), dir = await mkdtemp(join(tmpdir(), "wf-board-rules-variant-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let text = (await readFile(join(src, "rules.ts"), "utf8")).replaceAll(`from "./`, `from "${pathToFileURL(src).href}/`);
  for (const [find, replace] of edits) {
    assert.equal(text.split(find).length, 2, `the edit applies once: ${find}`);
    text = text.replace(find, replace);
  }
  await writeFile(join(dir, "rules.ts"), text);
  return await import(pathToFileURL(join(dir, "rules.ts")).href) as RulesModule;
}

/** The generated board of the browser tests' live-board weight (test/e2e/live-board.ts, without its padding and unread
 * history), as the store publishes it, with `start`: an hour after its seed. Sixty open items get a step in progress that
 * names another item; nothing has changed them since the seed, so their clocks read an hour of active time. */
async function liveSized(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-reuse-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { store } = await seedBoard(dir, generateBoard(1, 12));
  const seeded = store.snapshot(), rnd = prng(7), seededAt = Math.max(...seeded.activity!.writes.map(Date.parse)), start = seededAt + HOUR + 5 * MINUTE;
  const items = { ...seeded.items }, ids = Object.keys(items), r = current.rules(seeded, seededAt);
  const open = ids.filter(id => r.isOpenWork(id) && !r.isPaused(id) && items[id]!.plan.some(row => "text" in row && row.state === "todo" && !row.accept));
  const named: string[] = [];
  for (const id of open.slice(0, 60)) {
    const target = rnd.pick(ids);
    named.push(target);
    let started = false;
    items[id] = { ...items[id]!, plan: items[id]!.plan.map(row => !started && "text" in row && row.state === "todo" && !row.accept ? (started = true, { ...row, state: "doing" as const, since: stamp(seededAt), text: `${row.text} [[it:${target}]]` }) : row) };
  }
  // The board was written every twenty seconds since the seed, by writes that changed none of its items: active all along.
  const writes = [...seeded.activity!.writes];
  for (let at = seededAt; at < start; at += 20 * SECOND) writes.push(stamp(at));
  const s: Snapshot = { ...seeded, items, activity: { ...seeded.activity!, writes: writes.sort() } };
  return { s, start, named, stepping: open.slice(0, 60) };
}

/** A random write of the kinds sessions make; most of them change no field a status reads. */
function write(rnd: ReturnType<typeof prng>, s: Snapshot, at: string, pools: { named: string[]; waitingOnPaused: string[] }): { s: Snapshot; id: string; kind: string } {
  const kind = rnd.pick(["log", "log", "log", "named-log", "named-log", "head", "title", "waiter-title", "tags", "difficulty", "cardline", "plan-doing", "plan-done"]);
  const id = kind === "named-log" ? rnd.pick(pools.named) : kind === "waiter-title" && pools.waitingOnPaused.length ? rnd.pick(pools.waitingOnPaused) : rnd.pick(Object.keys(s.items));
  const it = s.items[id]!, next: Item = { ...it, updated: at };
  if (kind === "log" || kind === "named-log") next.log = [...it.log, { at, by: it.group, text: "进展" }];
  else if (kind === "head") next.head = (it.head ?? "") + "\n\n补充";
  else if (kind === "title" || kind === "waiter-title") next.title = it.title.length > 30 ? it.title.slice(0, 8) : it.title + " 很长很长很长很长很长很长很长很长的标题";
  else if (kind === "tags") next.tags = it.tags?.length ? [] : ["看板"];
  else if (kind === "difficulty") { if (it.difficulty === undefined) next.difficulty = 2; else delete next.difficulty; }
  else if (kind === "cardline") {
    const cards = Object.entries(s.decisions).filter(([, d]) => d.item === id).map(([key]) => key);
    next.head = cards.length && rnd.chance(0.5) ? (it.head ?? "") + "\n[[q:" + cards[0] + "]]\n" : (it.head ?? "").replace(/\n\[\[q:[^\]]+\]\]/g, "");
  } else {
    let done = false;
    next.plan = it.plan.map(row => !done && "text" in row && (kind === "plan-doing" ? row.state === "todo" : row.state === "doing") ? (done = true, kind === "plan-doing" ? { ...row, state: "doing" as const, since: at } : { ...row, state: "done" as const, doneAt: at }) : row);
  }
  return { s: { ...s, items: { ...s.items, [id]: next } }, id, kind };
}

/**
 * Runs `writes` random writes from `start`, a few seconds apart and now and then a minute later, each followed by a build
 * from the previous Rules object a moment later, as the page builds on each change event. Each Rules object is compared
 * with rules derived from nothing for the time it answers for after the next one was built from it: the next build then
 * reuses what the page would leave, part of its answers asked and the rest not. Stops at the first mismatch when
 * `firstMismatch`.
 */
function run(m: RulesModule, board: Awaited<ReturnType<typeof liveSized>>, writes: number, compare: (r: Rules, s: Snapshot) => string, firstMismatch = false) {
  const rnd = prng(20261018);
  let s = board.s, clock = board.start, time = clock, r = m.rules(s, time);
  const fresh = m.rules(s, time), paused = Object.keys(s.items).filter(id => fresh.isPaused(id));
  const waitingOnPaused = Object.keys(s.items).filter(id => fresh.isOpenWork(id) && !fresh.isPaused(id) && fresh.depsOf(id).some(d => d.kind === "item" && !d.own && paused.includes(d.id)));
  const pools = { named: board.named, waitingOnPaused };
  const reasons = new Map<string, number>(), kinds = new Map<string, number>(), mismatches: string[] = [];
  let pending: { r: Rules; s: Snapshot; time: number; what: string } | undefined;
  const check = (p: NonNullable<typeof pending>) => { if (compare(m.rules(p.s, p.time), p.s) !== compare(p.r, p.s)) mismatches.push(p.what); };
  for (let k = 0; k < writes && !(firstMismatch && mismatches.length); k++) {
    clock += rnd.chance(0.06) ? MINUTE : 300 + rnd.int(5000);
    const at = stamp(clock), w = write(rnd, s, at, pools);
    const delta: ActivityDelta = { from: String(k), write: at, items: { [w.id]: at }, pauses: {}, sessions: {} };
    const after: Snapshot = { ...w.s, activity: m.applyActivityDelta(s.activity, delta) };
    const built = clock + rnd.int(1500), next = m.rules(after, built, { previous: { rules: r, changed: [{ kind: "item", id: w.id }], activity: delta } });
    const reason = m.rebuiltBecause(next) ?? "reused";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1); kinds.set(w.kind, (kinds.get(w.kind) ?? 0) + 1);
    if (reason !== "reused") time = built;
    if (pending) check(pending);
    for (const id of Object.keys(after.items)) if (rnd.chance(0.5)) { next.statusOf(id); next.checks(id); next.stalledBelow(id); }
    pending = { r: next, s: after, time, what: `write ${k}: ${w.kind} on ${w.id}` };
    s = after; r = next;
  }
  if (pending && !(firstMismatch && mismatches.length)) check(pending);
  return { reasons, kinds, mismatches, stalledAtStart: Object.keys(board.s.items).filter(id => fresh.checks(id).some(c => c.label === m.STALLED_LABEL)).length, waitingOnPaused: waitingOnPaused.length };
}

test("reused rules answer what rules derived from nothing answer, after every write on a board of the live board's size", { timeout: 20 * 60_000 }, async t => {
  const board = await liveSized(t);
  assert.ok(Object.keys(board.s.items).length >= 1500, "the board has about 1,600 items");
  const { reasons, kinds, mismatches, stalledAtStart, waitingOnPaused } = run(current, board, 300, answers);
  console.log(`rules reuse: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(", ")}; writes ${[...kinds].map(([k, v]) => `${k} ${v}`).join(", ")}; ${stalledAtStart} stalled at the start, ${waitingOnPaused} waiting on paused work`);
  assert.deepEqual(mismatches, [], "every Rules object answers what a derivation from nothing answers");
  // The premises of the comparison: most writes reused, the rest refused for the reasons the sequence makes, and the
  // states the guards protect were there.
  assert.ok((reasons.get("reused") ?? 0) > 150, "most writes reused the previous Rules object");
  assert.ok((reasons.get("document") ?? 0) > 10 && (reasons.get("minute") ?? 0) > 5, "plan writes and new minutes built from nothing");
  assert.ok(stalledAtStart >= 30 && waitingOnPaused > 0, "stalled items and items waiting on paused work were there to be changed");
});

test("each guard of the reuse taken out makes the comparison fail", { timeout: 20 * 60_000 }, async t => {
  const board = await liveSized(t);
  const guards: Array<[string, Array<[string, string]>]> = [
    ["the written item and its owners", [["      up(id);\n", ""]]],
    ["the owners of a reached item, whose stalled counts read its checks", [["const up = (id: string) => { reach.add(id); for (const a of before.ancestors(id)) reach.add(a); };", "const up = (id: string) => { reach.add(id); };"]]],
    ["the items a written item waits on, whose pause check names its title", [["      for (const d of before.depsOf(id)) if (d.kind === \"item\") up(d.id);\n", ""]]],
    ["the items whose step in progress names a written item", [["      for (const target of [id, ...before.ancestors(id)]) for (const w of before.mentionedBy(target)) up(w);\n", ""]]],
  ];
  for (const [what, edits] of guards) {
    const { mismatches } = run(await variant(t, edits), board, 300, checksOnly, true);
    assert.ok(mismatches.length > 0, `without ${what}, a reused Rules object answers differently`);
  }
});

// Small boards for the refusals: each state is built by hand, the Rules object before the write is built at `built`, and the
// one after it is asked to reuse it in the same minute.
const T = Date.parse("2026-10-18T10:00:30Z");
const fixtureItem = (title: string, fields: Partial<Item> = {}) => Item.parse({ title, group: "P", difficulty: 2, plan: [{ id: "accept", accept: true, text: "passes", state: "todo" }], updated: stamp(T - 3 * HOUR), rev: 1, ...fields });
const doing = (since: number) => [{ id: "w", text: "work", state: "doing" as const, since: stamp(since) }, { id: "accept", accept: true as const, text: "passes", state: "todo" as const }];
function snapshot(items: Snapshot["items"], activity: NonNullable<Snapshot["activity"]>, decisions: Snapshot["decisions"] = {}): Snapshot {
  return { head: "0".repeat(40), board: { title: "Reuse", projects: [{ name: "P" }] }, glossaries: {}, notes: {}, owner: {}, items, decisions, activity };
}
/** The Rules object after a log write to `id` at `at`, built from `before` at `built` and asked to reuse it. */
function logWrite(m: RulesModule, before: { s: Snapshot; r: Rules }, id: string, at: number, built: number, extra: Partial<ActivityDelta> = {}) {
  const it = before.s.items[id]!, delta: ActivityDelta = { from: "x", write: iso(at), items: { [id]: iso(at) }, pauses: {}, sessions: {}, ...extra };
  const s: Snapshot = { ...before.s, items: { ...before.s.items, [id]: { ...it, log: [...it.log, { at: iso(at), text: "more" }], updated: iso(at) } }, activity: m.applyActivityDelta(before.s.activity, delta) };
  return { s, r: m.rules(s, built, { previous: { rules: before.r, changed: [{ kind: "item", id }], activity: delta } }) };
}

test("a write before the time the rules answer for, which widens the active time, builds from nothing", async t => {
  // a's step in progress has 59 min 59.5 s of active time since a last changed: one write at its change and one half a minute
  // short of the window later. Then the board was quiet for an hour.
  const changed = T - 2 * HOUR, s = snapshot({ a: fixtureItem("a", { plan: doing(changed) }), b: fixtureItem("b") },
    { writes: [iso(changed), iso(changed + 29 * MINUTE + 59.5 * SECOND)], items: { a: iso(changed), b: iso(changed) } });
  for (const m of [current, await variant(t, [["    if (was.intervals && JSON.stringify(activity().intervals) !== JSON.stringify(was.intervals)) return \"activity\";\n", ""]])]) {
    const r = m.rules(s, T);
    assert.equal(r.checks("a").some(c => c.label === m.STALLED_LABEL), false, "half a second short of an hour");
    // A write to b stamped a second before the rules were built: it adds a second of active time, and a passes the hour.
    const after = logWrite(m, { s, r }, "b", T - SECOND, T + 100);
    const fromNothing = m.rules(after.s, m === current ? T + 100 : T);
    assert.equal(fromNothing.checks("a").some(c => c.label === m.STALLED_LABEL), true, "a second more makes the hour");
    if (m === current) {
      assert.equal(current.rebuiltBecause(after.r), "activity");
      assert.equal(answers(after.r, after.s), answers(fromNothing, after.s));
    } else assert.notEqual(checksOnly(after.r, after.s), checksOnly(fromNothing, after.s), "without the guard, a's check stays as it was");
  }
});

test("a session's write that brings it back within its window builds from nothing", async t => {
  // a carries the dispatch of session e1, started seven hours ago with no write since: not live, so a is not worked on.
  const started = T - 7 * HOUR, dispatch = { agentId: "d1", agent: "e1", role: "工程师" as const, level: 2, model: "Sonnet", started: iso(started) };
  const s = snapshot({ a: fixtureItem("a", { dispatches: [dispatch] }), b: fixtureItem("b") }, { writes: [iso(started)], items: { a: iso(started), b: iso(started) } });
  for (const m of [current, await variant(t, [["      if (sessions?.has(id) && JSON.stringify(sessions.get(id)) !== JSON.stringify([...new Set(liveDispatches(s, id, now).map(d => d.agent))])) return \"session\";\n", ""]])]) {
    const r = m.rules(s, T);
    assert.equal(r.workedOn("a"), false);
    // e1 writes to b: its last activity is now, so a is worked on again.
    const after = logWrite(m, { s, r }, "b", T, T + 100, { agents: { e1: [{ item: "b", at: iso(T) }] } });
    const fromNothing = m.rules(after.s, T);
    assert.equal(fromNothing.workedOn("a"), true);
    if (m === current) {
      assert.equal(current.rebuiltBecause(after.r), "session");
      assert.equal(answers(after.r, after.s), answers(m.rules(after.s, T + 100), after.s));
    } else assert.notEqual(after.r.workedOn("a"), fromNothing.workedOn("a"), "without the guard, a is still not worked on");
  }
});

test("a write in another minute, one that changes what a status reads, and a card build from nothing", () => {
  const s = snapshot({ a: fixtureItem("a"), b: fixtureItem("b") }, { writes: [stamp(T - HOUR)], items: {} },
    { q: Decision.parse({ item: "a", question: "Which?", options: [{ key: "A", text: "a" }, { key: "B", text: "b" }, { key: "C", text: "c" }], status: "open", updated: stamp(T), rev: 1 }) });
  const r = current.rules(s, T);
  assert.equal(current.rebuiltBecause(r), "no previous");
  assert.equal(current.rebuiltBecause(logWrite(current, { s, r }, "b", T, T + 100).r), null, "a log write in the same minute reuses");
  assert.equal(current.rebuiltBecause(logWrite(current, { s, r }, "b", T + 30 * SECOND, T + 31 * SECOND).r), "minute");
  for (const [field, value] of [["plan", []], ["paused", { reason: "wait", at: stamp(T) }], ["group", "Q"], ["order", 3]] as const) {
    const after: Snapshot = { ...s, items: { ...s.items, b: { ...s.items.b!, [field]: value } } };
    assert.equal(current.rebuiltBecause(current.rules(after, T + 100, { previous: { rules: r, changed: [{ kind: "item", id: "b" }] } })), "document", field);
  }
  const ruled: Snapshot = { ...s, decisions: { q: { ...s.decisions.q!, status: "ruled", choice: "A" } } };
  const built = current.rules(ruled, T + 100, { previous: { rules: r, changed: [{ kind: "decision", id: "q" }] } });
  assert.equal(current.rebuiltBecause(built), "document");
  assert.equal(answers(built, ruled), answers(current.rules(ruled, T + 100), ruled));
});
