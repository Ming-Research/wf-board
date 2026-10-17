import assert from "node:assert/strict";
import test from "node:test";
import { Item, Decision } from "../src/model.ts";
import type { PlanRow, Snapshot, Status } from "../src/model.ts";
import { rules } from "../src/rules.ts";
import { derivePlanOracle } from "../src/plan-conversion-oracle.ts";

const at = "2026-10-13T00:00:00Z";
const acceptance = (state: "todo" | "done" = "todo"): PlanRow => ({ id: "accept", accept: true, text: "The independent check passes", state, ...(state === "done" ? { doneAt: at } : {}) });
function fixture(plan: PlanRow[], target: Partial<Item> = {}, cardStatus: "open" | "ruled" | "withdrawn" = "open"): Snapshot {
  return {
    head: "0".repeat(40), board: { title: "Plan oracle", projects: [{ name: "P" }] }, glossaries: {}, notes: {}, owner: {},
    items: { subject: Item.parse({ title: "Subject", group: "P", priority: "P1", plan, updated: at, rev: 1 }), target: Item.parse({ title: "Target", group: "P", plan: [acceptance()], updated: at, rev: 1, ...target }) },
    decisions: { q: Decision.parse({ item: "subject", question: "Proceed?", options: [{ key: "A", text: "Proceed" }], status: cardStatus, updated: at, rev: 1 }) },
  };
}

// The old artifact oracle described the retired parent/deps/manual-status and
// per-project priority rules. These tables instead transcribe the approved row
// state and frontier rules; expected answers never call the implementation.
test("independent row-state table covers normal, cancelled, record and missing targets", () => {
  const cases: Array<{ row: PlanRow; target?: Partial<Item>; card?: "open" | "ruled" | "withdrawn"; expected: [string, string, boolean, boolean, Status] }> = [
    { row: { id: "x", text: "X", state: "todo" }, expected: ["open", "○", false, false, "todo"] },
    { row: { id: "x", text: "X", state: "doing", since: at }, expected: ["progress", "●", false, false, "wip"] },
    { row: { id: "x", text: "X", state: "done", doneAt: at }, expected: ["resolved", "✓", false, false, "todo"] },
    { row: { id: "x", text: "X", state: "dropped", reason: "Replaced", droppedAt: at }, expected: ["resolved", "✗", true, true, "todo"] },
    { row: { id: "target", item: "target", own: true }, expected: ["open", "○", false, false, "todo"] },
    { row: { id: "target", item: "target", own: true }, target: { plan: [{ id: "work", text: "Work", state: "doing", since: at }, acceptance()] }, expected: ["progress", "●", false, false, "wip"] },
    { row: { id: "target", item: "target", own: true }, target: { ask: { text: "Approve" } }, expected: ["waiting", "⏸", false, false, "blocked"] },
    { row: { id: "target", item: "target", own: true }, target: { plan: [acceptance("done")] }, expected: ["resolved", "✓", false, false, "todo"] },
    { row: { id: "target", item: "target", own: true }, target: { status: "cancelled" }, expected: ["resolved", "✗", true, true, "todo"] },
    { row: { id: "target", item: "target", own: false }, expected: ["waiting", "⏸", false, false, "blocked"] },
    { row: { id: "target", item: "target", own: false }, target: { status: "cancelled" }, expected: ["waiting", "⏸", false, false, "blocked"] },
    { row: { id: "target", item: "target", own: false }, target: { plan: [acceptance("done")] }, expected: ["resolved", "✓", false, false, "todo"] },
    { row: { id: "target", item: "target", own: true }, target: { record: true, plan: [] }, expected: ["resolved", "✓", false, true, "todo"] },
    { row: { id: "target", item: "target", own: false }, target: { record: true, plan: [] }, expected: ["resolved", "✓", false, false, "todo"] },
    { row: { id: "gone", item: "gone", own: true }, expected: ["waiting", "⏸", false, false, "blocked"] },
    { row: { id: "gone", item: "gone", own: false }, expected: ["waiting", "⏸", false, false, "blocked"] },
    { row: { id: "q", card: "q" }, expected: ["waiting", "⏸", false, false, "blocked"] },
    { row: { id: "gone", card: "gone" }, expected: ["waiting", "⏸", false, false, "blocked"] },
    ...(["ruled", "withdrawn"] as const).map(card => ({ row: { id: "q", card: "q" } as PlanRow, card, expected: ["resolved", "✓", false, false, "todo"] as [string, string, boolean, boolean, Status] })),
  ];
  for (const c of cases) {
    const r = rules(fixture([c.row, acceptance()], c.target, c.card)), first = r.planRows("subject")[0]!;
    assert.deepEqual([first.state, first.glyph, first.dropped, first.excluded, r.statusOf("subject")], c.expected, JSON.stringify(c));
    assert.equal(first.ready, first.state !== "resolved");
  }
});

test("independent frontier examples distinguish sequential waits, parallel work and acceptance", () => {
  const wait: PlanRow = { id: "target", item: "target", own: false, after: [] };
  const step: PlanRow = { id: "work", text: "Work", state: "todo" };
  const cases: Array<[PlanRow[], Status, boolean[]]> = [
    [[wait, step, acceptance()], "blocked", [true, false, false]],
    [[wait, { ...step, after: [] }, acceptance()], "todo", [true, true, false]],
    [[{ ...step, state: "doing", since: at }, wait, acceptance()], "wip", [true, true, false]],
    [[{ ...step, state: "done", doneAt: at }, acceptance()], "todo", [false, true]],
    [[{ ...step, state: "done", doneAt: at }, acceptance("done")], "done", [false, false]],
  ];
  for (const [plan, status, ready] of cases) { const r = rules(fixture(plan)); assert.equal(r.statusOf("subject"), status); assert.deepEqual(r.planRows("subject").map(row => row.ready), ready); }
});

test("production and independent oracle use ordinary acceptance prerequisites before delivery", () => {
  const s = fixture([acceptance()]);
  const wait: PlanRow = { id: "target", item: "target", own: false, after: [] };
  const checked: PlanRow = { id: "checked", text: "Checked work", state: "done", doneAt: at, after: [] };
  for (const after of [undefined, ["checked"], []]) {
    // Raw assignment separates frontier semantics from schema acceptance.
    s.items.subject!.plan = [wait, checked, { ...acceptance(), ...(after === undefined ? {} : { after }) }, { id: "merge", text: "Deliver work", state: "todo" }];
    const expected = [true, false, true, false];
    assert.deepEqual(rules(s).planRows("subject").map(row => row.ready), expected);
    assert.deepEqual(derivePlanOracle(s).rows("subject").map(row => row.ready), expected);
  }
  s.items.subject!.plan = [checked, acceptance("done"), { id: "scenario", text: "Second acceptance scenario", accept: true, state: "todo" }, { id: "merge", text: "Deliver work", state: "todo" }];
  assert.equal(rules(s).statusOf("subject"), "todo");
  assert.equal(derivePlanOracle(s).statusOf("subject"), "todo");
  s.items.subject!.plan[2] = { id: "scenario", text: "Second acceptance scenario", accept: true, state: "done", doneAt: at };
  assert.equal(rules(s).statusOf("subject"), "todo");
  assert.equal(derivePlanOracle(s).statusOf("subject"), "todo");
  s.items.subject!.plan[3] = { id: "merge", text: "Deliver work", state: "done", doneAt: at };
  assert.equal(rules(s).statusOf("subject"), "done");
  assert.equal(derivePlanOracle(s).statusOf("subject"), "done");
});
