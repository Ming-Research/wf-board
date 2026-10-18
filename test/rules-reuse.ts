// What the tests of the rules' reuse share (test/rules-reuse-*.test.ts): rules that reuse the Rules object of the state before
// a write (rules' `previous`, docs/design.md section 4, Write cost) must answer exactly what rules derived from nothing answer,
// for the time they answer for. The oracle is that from-scratch derivation, on a generated board of the live board's size after
// random writes of the kinds sessions make. The writes are split over files of their own seeds, so the shards of the full CI
// run them side by side.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as current from "../src/rules.ts";
import type { ActivityDelta, Rules } from "../src/rules.ts";
import { Decision, Glossary, Item, Note } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { generateBoard, prng } from "./e2e/board-gen.ts";

export type RulesModule = Pick<typeof current, "rules" | "rebuiltBecause" | "applyActivityDelta" | "STALLED_LABEL">;
export const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE;
export const iso = (ms: number) => new Date(ms).toISOString();
/** A write's time as the store stamps it: whole seconds, so it can fall before a page's build in the same second. */
export const stamp = (ms: number) => new Date(Math.floor(ms / SECOND) * SECOND).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Everything a Rules object answers, for every item and card: two that agree here agree for the page and the server. */
export function answers(r: Rules, s: Snapshot): string {
  const ids = Object.keys(s.items).sort();
  return JSON.stringify([r.areas(), [...ids].sort(r.compareCandidates), [...ids].sort(r.compareSiblings),
    Object.keys(s.decisions).sort().map(key => [key, r.cardChecks(key), r.cardWaiting(key), r.cardBlocking(key), r.cardDependents(key)]),
    ids.map(id => [id, r.item(id), r.statusOf(id), r.checks(id), r.refusals(id), r.planRows(id), r.planGroups(id), r.planRatio(id), r.progressShare(id), r.stages(id),
      r.planRows(id).map(row => "text" in row.row ? r.stepLine(row.row) : null), r.depsOf(id), r.dependents(id), r.isNeeded(id),
      r.canStart(id), r.startable(id), r.progress(id), r.stalledBelow(id), r.blockingBelow(id), r.nonBlockingBelow(id), r.pausedBy(id),
      r.isPaused(id), r.isOpenWork(id), r.isRoot(id), r.isBacklog(id), r.isLeaf(id), r.children(id), r.ancestors(id), r.lineOf(id),
      r.groupOf(id), r.onCycle(id), r.needsOwner(id), r.ownerBlocking(id), r.askPending(id), r.workedOn(id), r.begun(id),
      r.openDependents(id), r.mentionedBy(id), r.cardsOf(id), r.parentOf(id)])]);
}
/** Only the checks and the stalled counts: what the guards taken out in the copies leave wrong. */
export function checksOnly(r: Rules, s: Snapshot): string {
  return JSON.stringify(Object.keys(s.items).sort().map(id => [id, r.checks(id), r.stalledBelow(id)]));
}

/** src/rules.ts with `edits` applied, loaded as a module of its own; each edit must match exactly once. */
export async function variant(t: { after(fn: () => unknown): void }, edits: Array<[string, string]>): Promise<RulesModule> {
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
 * history), its documents as the schemas read them and its activity as the store would note it, one write a second, with
 * `start`: an hour after the last. Sixty open items get a step in progress that names another item; nothing has changed
 * them since, so their clocks read an hour of active time. Built without a store, so a file of these tests spends its time on
 * the comparisons. */
export function liveSized() {
  const gen = generateBoard(1, 12), seededAt = Date.parse("2026-10-18T00:00:00Z"), start = seededAt + HOUR + 5 * MINUTE;
  const s: Snapshot = { head: "0".repeat(40), board: gen.board as Snapshot["board"], owner: {}, items: {}, decisions: {}, notes: {}, glossaries: {}, activity: { writes: [], items: {} } };
  const schemas = { item: [Item, s.items], decision: [Decision, s.decisions], note: [Note, s.notes], glossary: [Glossary, s.glossaries] } as const;
  gen.batches.forEach((batch, k) => {
    const at = stamp(seededAt - (gen.batches.length - 1 - k) * SECOND);
    s.activity!.writes.push(at);
    for (const put of batch.puts) {
      const [schema, docs] = schemas[put.kind as keyof typeof schemas] as unknown as [{ parse(doc: unknown): { rev: number } }, Record<string, { rev: number }>];
      if (put.doc === null) { delete docs[put.id]; continue; }
      docs[put.id] = schema.parse({ ...put.doc as object, rev: (docs[put.id]?.rev ?? 0) + 1 });
      const item = put.kind === "item" ? put.id : put.kind === "decision" ? (put.doc as { item: string }).item : put.kind === "note" ? (put.doc as { target: string }).target.replace(/^it:/, "") : undefined;
      if (item && !item.startsWith("q:")) s.activity!.items[item] = at;
    }
  });
  const rnd = prng(7), ids = Object.keys(s.items), r = current.rules(s, seededAt);
  const open = ids.filter(id => r.isOpenWork(id) && !r.isPaused(id) && s.items[id]!.plan.some(row => "text" in row && row.state === "todo" && !row.accept));
  const named: string[] = [];
  for (const id of open.slice(0, 60)) {
    const target = rnd.pick(ids);
    named.push(target);
    let started = false;
    s.items[id] = { ...s.items[id]!, plan: s.items[id]!.plan.map(row => !started && "text" in row && row.state === "todo" && !row.accept ? (started = true, { ...row, state: "doing" as const, since: stamp(seededAt), text: `${row.text} [[it:${target}]]` }) : row) };
  }
  // The board was written every twenty seconds since, by writes that changed none of its items: active all along.
  for (let at = seededAt + 20 * SECOND; at < start; at += 20 * SECOND) s.activity!.writes.push(stamp(at));
  return { s, start, named };
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
export function run(m: RulesModule, board: ReturnType<typeof liveSized>, seed: number, writes: number, compare: (r: Rules, s: Snapshot) => string, firstMismatch = false) {
  const rnd = prng(seed);
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
