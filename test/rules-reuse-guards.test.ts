// Each guard of the rules' reuse taken out of a copy of src/rules.ts makes the comparison with rules derived from nothing fail
// (test/rules-reuse.ts), and each refusal to reuse has a small board of its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as current from "../src/rules.ts";
import type { ActivityDelta, Rules } from "../src/rules.ts";
import { Decision, Item } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { answers, checksOnly, HOUR, iso, liveSized, MINUTE, run, SECOND, stamp, variant } from "./rules-reuse.ts";
import type { RulesModule } from "./rules-reuse.ts";

test("each guard of the reuse taken out makes the comparison fail", { timeout: 20 * 60_000 }, async t => {
  const board = liveSized();
  const guards: Array<[string, Array<[string, string]>]> = [
    ["the written item and its owners", [["      up(id);\n", ""]]],
    ["the owners of a reached item, whose stalled counts read its checks", [["const up = (id: string) => { reach.add(id); for (const a of before.ancestors(id)) reach.add(a); };", "const up = (id: string) => { reach.add(id); };"]]],
    ["the items a written item waits on, whose pause check names its title", [["      for (const d of before.depsOf(id)) if (d.kind === \"item\") up(d.id);\n", ""]]],
    ["the items whose step in progress names a written item", [["      for (const target of [id, ...before.ancestors(id)]) for (const w of before.mentionedBy(target)) up(w);\n", ""]]],
  ];
  for (const [what, edits] of guards) {
    const { mismatches } = run(await variant(t, edits), board, 20261018, 300, checksOnly, true);
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
