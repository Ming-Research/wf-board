// Standing items (docs/design.md, section 5, Item plans, Standing items): the schema, the status, the plan rows, the checks, the
// need that passes through them, and how the MCP rows and the whole view show them. The writes are in test/standing-ops.test.ts, the
// comparison on a whole board in test/standing-board.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { Item } from "../src/model.ts";
import type { PlanRow, PlanStep, Snapshot } from "../src/model.ts";
import { rules, checkKind, checkKey } from "../src/rules.ts";
import { wholeView } from "../src/whole-view.ts";
import { brief, context, list } from "../src/query.ts";

const T0 = "2026-10-10T00:00:00Z", NOW = Date.parse("2026-10-12T00:00:00Z");
const step = (id = "work", state: PlanStep["state"] = "todo", fields: Partial<PlanStep> = {}): PlanStep => ({ id, text: id, state, ...(state === "done" ? { doneAt: T0 } : state === "doing" ? { since: T0 } : {}), ...fields });
const accept = (state: PlanStep["state"] = "todo"): PlanStep => step("accept", state, { accept: true, text: "Checks pass" });
const own = (item: string): PlanRow => ({ id: item, item, own: true });
const ownNow = (item: string): PlanRow => ({ id: item, item, own: true, after: [] });
const shared = (item: string): PlanRow => ({ id: item, item, own: false });
/** An ordinary rated work item unless `fields` say otherwise. */
function snapshot(items: Record<string, Partial<Item>>): Snapshot {
  return {
    board: { title: "Synthetic", projects: [{ name: "Default" }] }, head: "0".repeat(40), glossaries: {}, owner: {}, decisions: {}, notes: {},
    items: Object.fromEntries(Object.entries(items).map(([id, fields]) => [id, Item.parse({ title: id, group: "Default", difficulty: 2, plan: [step(), accept()], updated: T0, rev: 1, ...fields })])),
  };
}
/** A standing item: no acceptance step, no difficulty. */
const standing = (fields: Partial<Item> = {}): Partial<Item> => ({ standing: true, difficulty: undefined, plan: [step()], ...fields });
const ids = (s: Snapshot, id: string) => rules(s).checks(id).map(c => c.id);

test("the schema gives a standing item no acceptance step and no difficulty, and keeps it apart from a record", () => {
  const base = { title: "Rules", group: "Default", updated: T0, rev: 1 };
  assert.equal(Item.safeParse({ ...base, standing: true, plan: [step()] }).success, true);
  assert.equal(Item.safeParse({ ...base, standing: true, plan: [] }).success, true, "a standing item may have no rows at all");
  assert.equal(Item.safeParse({ ...base, standing: true, plan: [step(), accept()] }).success, false, "no acceptance step");
  assert.equal(Item.safeParse({ ...base, standing: true, difficulty: 2, plan: [] }).success, false, "no difficulty");
  assert.equal(Item.safeParse({ ...base, standing: true, record: true, plan: [] }).success, false, "not a record");
  assert.equal(Item.safeParse({ ...base, standing: false, plan: [step()] }).success, false, "the mark is `true` or absent, and an ordinary item needs its acceptance step");
});

test("a standing item is in progress whatever its rows say, paused with its pause or its owner's, and cancelled when cancelled", () => {
  const s = snapshot({
    todo: standing({ plan: [step("a", "todo")] }),
    allDone: standing({ plan: [step("a", "done")] }),
    empty: standing({ plan: [] }),
    waiting: standing({ plan: [shared("other")] }),
    paused: standing({ paused: { reason: "owner asked", at: T0 } }),
    owner: standing({ plan: [own("below"), own("stand")], paused: { reason: "owner asked", at: T0 } }),
    below: {},
    stand: standing(),
    gone: standing({ status: "cancelled" }),
    other: {},
  });
  const r = rules(s);
  for (const id of ["todo", "allDone", "empty", "waiting"]) assert.equal(r.statusOf(id), "wip", `${id} is in progress`);
  assert.equal(r.statusOf("paused"), "paused");
  assert.equal(r.statusOf("below"), "paused", "an ordinary item under a paused standing item is paused");
  assert.equal(r.statusOf("stand"), "paused", "and so is a standing item under it");
  assert.equal(r.statusOf("gone"), "cancelled");
  assert.equal(r.isStanding("todo"), true);
  assert.equal(r.isStanding("other"), false);
  assert.equal(r.isOpenWork("allDone"), true, "never done");
  assert.equal(r.planRatio("allDone").total, 0, "and it has no share of its plan done to count");
  assert.equal(r.progressShare("allDone"), 0);
  // The control: an ordinary item with the same rows is done, so the status above is the mark's doing.
  assert.equal(rules(snapshot({ done: { plan: [step("a", "done"), accept("done")] } })).statusOf("done"), "done");
});

test("the plan rows of a standing item for other standing items are resolved, drawn ∞ and uncounted, and do not hold back the item after them", () => {
  const s = snapshot({
    rules: standing({ plan: [own("b1"), own("b2"), own("work")] }),
    b1: standing(), b2: standing(), work: {},
    ordinary: { plan: [own("c1"), own("c2"), accept()] },
    c1: { plan: [step("w", "doing"), accept()] }, c2: {},
  });
  const r = rules(s), rows = r.planRows("rules");
  assert.deepEqual(rows.map(row => row.glyph), ["∞", "∞", "○"]);
  assert.deepEqual(rows.map(row => row.state), ["resolved", "resolved", "open"]);
  assert.deepEqual(rows.map(row => row.excluded), [true, true, false]);
  assert.equal(r.statusOf("work"), "todo", "the ordinary item under the standing one starts: the rows before its row are resolved");
  assert.deepEqual(r.ownerRowWaits("work"), []);
  // The control: the same shape under an ordinary owner holds the item back behind the sibling in progress.
  assert.equal(r.statusOf("c1"), "wip");
  assert.equal(r.statusOf("c2"), "blocked", "an ordinary sibling in progress holds the next row back");
  assert.deepEqual(r.ownerRowWaits("c2"), ["c1"]);
});

test("an ordinary item's row for a standing item is never resolved, however finished the standing item's rows are", () => {
  const s = snapshot({ owner: { plan: [own("rule"), own("after"), accept()] }, rule: standing({ plan: [step("a", "done")] }), after: {} });
  const r = rules(s);
  assert.equal(r.planRows("owner")[0]!.state, "progress");
  assert.deepEqual(r.ownerRowWaits("after"), ["rule"], "the standing item is not done, so the item after it waits");
});

test("a standing item raises none of the checks that ask for an acceptance step or a rating, and an ordinary item with the same rows does", () => {
  const s = snapshot({
    rule: standing({ plan: [step("a", "done"), step("b", "done")] }),
    bare: standing({ plan: [] }),
    ordinary: { difficulty: undefined, plan: [step("a", "done"), step("b", "done"), accept()] },
  });
  assert.deepEqual(ids(s, "rule"), []);
  assert.deepEqual(ids(s, "bare"), []);
  assert.deepEqual(ids(s, "ordinary").sort(), ["difficulty-missing", "only-acceptance-left"]);
  assert.equal(rules(s).canStart("rule"), false);
  assert.equal(rules(s).startable("rule"), false);
});

test("the checks that do not depend on the mark stay on a standing item", () => {
  const s = snapshot({
    rule: standing({ plan: [step("a", "todo", { waits: "CI" }), shared("missing")], title: "一二三四五六七八九十一二三四五六七八九十一" }),
    cycleA: standing({ plan: [shared("cycleB")] }), cycleB: standing({ plan: [shared("cycleA")] }),
  });
  assert.deepEqual(ids(s, "rule").sort(), ["dep-item-missing", "title-too-long", "waits-in-text"]);
  assert.ok(ids(s, "cycleA").includes("dep-cycle"), "a loop of standing items is still a loop");
});

test("a row of an ordinary item that owns or shares a standing item raises the refused check, and no other pair does", () => {
  assert.equal(checkKind("waits-on-standing").refused, true);
  const s = snapshot({
    sharing: { plan: [shared("rule"), accept()] },
    owning: { plan: [own("rule2"), accept()] },
    rule: standing(), rule2: standing(),
    parent: standing({ plan: [own("kid"), shared("rule")] }), kid: standing(),
    record: { record: true, difficulty: undefined, plan: [own("rule3")] }, rule3: standing(),
    plain: { plan: [shared("sharing"), accept()] },
  });
  const r = rules(s);
  const checks = (id: string) => r.refusals(id).filter(c => c.id === "waits-on-standing");
  assert.deepEqual(checks("sharing").map(c => c.target), [{ kind: "item", id: "rule" }]);
  assert.match(checks("sharing")[0]!.text, /等着一个常设条目/);
  assert.deepEqual(checks("owning").map(c => c.target), [{ kind: "item", id: "rule2" }]);
  assert.match(checks("owning")[0]!.text, /拥有一个常设条目/);
  for (const id of ["parent", "record", "plain", "kid", "rule"]) assert.deepEqual(checks(id), [], `${id}: no such row of an ordinary item`);
  // Two such rows are two checks the occurrence of which the target tells apart.
  const two = rules(snapshot({ both: { plan: [shared("a"), shared("b"), accept()] }, a: standing(), b: standing() }));
  assert.equal(new Set(two.refusals("both").filter(c => c.id === "waits-on-standing").map(checkKey)).size, 2);
});

test("a standing item's row for another standing item makes the target neither awaited nor in conflict with its pause, and a row for ordinary work still does", () => {
  const paused = { reason: "owner asked", at: T0 };
  const s = snapshot({
    // Two standing items side by side at the top of one project, one sharing the other, the other paused.
    waiter: standing({ plan: [shared("target")] }), target: standing({ paused }),
    // The same shape with an ordinary target, the control: that row really waits.
    waiter2: standing({ plan: [shared("plain")] }), plain: { paused },
  });
  const r = rules(s), kinds = (id: string) => r.checks(id).map(c => c.id);
  assert.deepEqual(kinds("target"), []);
  // The checks a write is refused for are the ones of a kind marked so.
  const refused = (id: string) => r.refusals(id).filter(c => checkKind(c.id).refused).map(c => c.id);
  assert.deepEqual(refused("target"), [], "so the write that builds the row is not refused");
  assert.deepEqual(kinds("waiter"), []);
  assert.deepEqual(kinds("plain").sort(), ["pause-conflict", "unowned-but-awaited"], "the control raises both, so the checks are alive");
  assert.deepEqual(refused("plain"), ["unowned-but-awaited"]);
});

test("an unpaused standing item passes the need to the items it owns while it is never startable itself, and a pause takes the need away", () => {
  const items = (paused: boolean) => snapshot({
    rule: standing({ plan: [ownNow("kid")], ...(paused ? { paused: { reason: "owner asked", at: T0 } } : {}) }),
    kid: { difficulty: undefined },
  });
  const r = rules(items(false));
  assert.equal(r.isNeeded("rule"), true);
  assert.equal(r.isNeeded("kid"), true, "the need goes on through the standing item");
  assert.equal(r.canStart("kid"), true);
  assert.deepEqual(r.checks("kid").map(c => c.id), ["difficulty-missing"], "so the item under it is still asked for its rating");
  assert.equal(r.canStart("rule"), false);
  assert.deepEqual(r.checks("rule").map(c => c.id), []);
  const paused = rules(items(true));
  assert.equal(paused.isNeeded("kid"), false);
  assert.equal(paused.canStart("kid"), false);
  assert.deepEqual(paused.checks("kid").map(c => c.id), [], "a paused item is not asked for a rating");
});

test("a standing item with a step in progress is told when it goes quiet; one without is not", () => {
  const hour = 60 * 60 * 1000, start = Date.parse(T0), timeAt = (hours: number) => new Date(start + hours * hour).toISOString();
  const s = snapshot({ quiet: standing({ plan: [step("a", "doing")] }), calm: standing({ plan: [step("a", "todo")] }) });
  // Seven writes over three hours, the last item write at the start: three active hours, more than the one that makes a step stalled.
  s.activity = { writes: Array.from({ length: 7 }, (_, i) => timeAt(i / 2)), items: { quiet: T0, calm: T0 } };
  const r = rules(s, start + 3 * hour);
  assert.deepEqual(r.checks("quiet").map(c => c.id), ["stalled"]);
  assert.deepEqual(r.checks("calm").map(c => c.id), []);
});

test("the whole view leaves out a standing item nobody works on, and lists it once the runner reports on it", () => {
  const s = snapshot({ rule: standing(), plain: {} });
  const view = (snap: Snapshot) => wholeView(snap, rules(snap, NOW), NOW);
  assert.deepEqual(view(s).rows.map(row => row.id), ["plain"], "the ordinary item with nobody on it is a row; the standing one is not");
  assert.equal(view(s).projects[0]!.remaining, 1);
  const reported = snapshot({ rule: standing({ runner: { state: "running", since: T0, at: T0, started: T0 } }), plain: {} });
  assert.deepEqual(view(reported).rows.map(row => row.id).sort(), ["plain", "rule"]);
});

test("list, context and brief say which items are standing, and brief names the ones that are not paused under its progress", () => {
  const s = snapshot({ rule: standing({ plan: [ownNow("kid")] }), kid: {}, stopped: standing({ paused: { reason: "owner asked", at: T0 } }), plain: {} });
  const r = rules(s);
  const rows = list(s, r, { limit: 20 });
  assert.equal(rows.find(row => row.id === "rule")!.standing, true);
  assert.equal(rows.find(row => row.id === "plain")!.standing, undefined);
  const standingOf = (ref: string): boolean | undefined => { const c = context(s, r, ref); return "standing" in c ? c.standing : undefined; };
  assert.equal(standingOf("rule"), true);
  assert.equal(standingOf("plain"), undefined);
  const b = brief(s, r, "Default");
  assert.deepEqual(b.progress.map(row => row.id), ["rule"], "the standing item in force is under progress; the paused one is under paused");
  assert.deepEqual(b.paused.map(row => row.id), ["stopped"]);
  assert.deepEqual(b.checks, [], "and neither has a check to read");
});
