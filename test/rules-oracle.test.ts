import assert from "node:assert/strict";
import test from "node:test";
import { Item, Decision } from "../src/model.ts";
import type { PlanRow, Snapshot, Status } from "../src/model.ts";
import { rules } from "../src/rules.ts";
import { derivePlanOracle } from "../src/plan-conversion-oracle.ts";

const at = "2026-10-13T00:00:00Z";
const acceptance = (state: "todo" | "done" = "todo"): PlanRow => ({ id: "accept", accept: true, text: "The independent check passes", state, ...(state === "done" ? { doneAt: at } : {}) });
function fixture(plan: PlanRow[], target: Partial<Item> = {}, cardStatus: "open" | "ruled" | "withtree" | "elsewhere" = "open"): Snapshot {
  return {
    head: "0".repeat(40), board: { title: "Plan oracle", projects: [{ name: "P" }] }, glossaries: {}, notes: {}, owner: {},
    items: { subject: Item.parse({ title: "Subject", group: "P", priority: "P1", plan, updated: at, rev: 1 }), target: Item.parse({ title: "Target", group: "P", plan: [acceptance()], updated: at, rev: 1, ...target }) },
    decisions: { q: Decision.parse({ item: "target", question: "Proceed?", background: "Independent evidence", options: [{ key: "A", text: "Proceed" }], status: cardStatus, updated: at, rev: 1 }) },
  };
}

// The old artifact oracle described the retired parent/deps/manual-status and
// per-project priority rules. These tables instead transcribe the approved row
// state and frontier rules; expected answers never call the implementation.
test("independent row-state table covers normal, cancelled, record and missing targets", () => {
  const cases: Array<{ row: PlanRow; target?: Partial<Item>; card?: "open" | "ruled" | "withtree" | "elsewhere"; expected: [string, string, boolean, boolean, Status] }> = [
    { row: { id: "x", text: "X", state: "todo" }, expected: ["open", "○", false, false, "todo"] },
    { row: { id: "x", text: "X", state: "doing", since: at }, expected: ["progress", "●", false, false, "wip"] },
    { row: { id: "x", text: "X", state: "done", doneAt: at }, expected: ["resolved", "✓", false, false, "stalled"] },
    { row: { id: "x", text: "X", state: "dropped", reason: "Replaced", droppedAt: at }, expected: ["resolved", "✗", true, true, "todo"] },
    { row: { id: "target", item: "target", own: true }, expected: ["open", "○", false, false, "todo"] },
    { row: { id: "target", item: "target", own: true }, target: { plan: [{ id: "work", text: "Work", state: "doing", since: at }, acceptance()] }, expected: ["progress", "●", false, false, "wip"] },
    { row: { id: "target", item: "target", own: true }, target: { ask: { text: "Approve" } }, expected: ["waiting", "⏸", false, false, "blocked"] },
    { row: { id: "target", item: "target", own: true }, target: { plan: [acceptance("done")] }, expected: ["resolved", "✓", false, false, "stalled"] },
    { row: { id: "target", item: "target", own: true }, target: { status: "cancelled" }, expected: ["resolved", "✗", true, true, "todo"] },
    { row: { id: "target", item: "target", own: false }, expected: ["waiting", "⏸", false, false, "blocked"] },
    { row: { id: "target", item: "target", own: false }, target: { status: "cancelled" }, expected: ["waiting", "⏸", false, false, "blocked"] },
    // What others finished is not this item's own work: a done shared target leaves the item at todo.
    { row: { id: "target", item: "target", own: false }, target: { plan: [acceptance("done")] }, expected: ["resolved", "✓", false, false, "todo"] },
    { row: { id: "target", item: "target", own: true }, target: { record: true, plan: [] }, expected: ["resolved", "✓", false, true, "todo"] },
    { row: { id: "target", item: "target", own: false }, target: { record: true, plan: [] }, expected: ["resolved", "✓", false, false, "todo"] },
    { row: { id: "gone", item: "gone", own: true }, expected: ["waiting", "⏸", false, false, "blocked"] },
    { row: { id: "gone", item: "gone", own: false }, expected: ["waiting", "⏸", false, false, "blocked"] },
    { row: { id: "q", card: "q" }, expected: ["waiting", "⏸", false, false, "blocked"] },
    { row: { id: "gone", card: "gone" }, expected: ["waiting", "⏸", false, false, "blocked"] },
    ...(["ruled", "withtree", "elsewhere"] as const).map(card => ({ row: { id: "q", card: "q" } as PlanRow, card, expected: ["resolved", "✓", false, false, "todo"] as [string, string, boolean, boolean, Status] })),
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
    [[{ ...step, state: "done", doneAt: at }, acceptance()], "stalled", [false, true]],
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
  assert.equal(rules(s).statusOf("subject"), "stalled");
  assert.equal(derivePlanOracle(s).statusOf("subject"), "stalled");
  s.items.subject!.plan[2] = { id: "scenario", text: "Second acceptance scenario", accept: true, state: "done", doneAt: at };
  assert.equal(rules(s).statusOf("subject"), "stalled");
  assert.equal(derivePlanOracle(s).statusOf("subject"), "stalled");
  s.items.subject!.plan[3] = { id: "merge", text: "Deliver work", state: "done", doneAt: at };
  assert.equal(rules(s).statusOf("subject"), "done");
  assert.equal(derivePlanOracle(s).statusOf("subject"), "done");
});

// Status after the progress rules (docs/design.md, Status): done, paused and cancelled as before; then a row in progress
// holds the item; then blocked; then a live session holds it; then a row done here or below makes it part way; else todo.
// Each expected status is written from those rules, never read from the implementation, and the independent oracle
// has to agree with the production derivation on every case.
test("status table: held, part way and untouched, with sessions inside and outside the six-hour window", () => {
  const now = Date.parse("2026-10-17T12:00:00Z"), ago = (hours: number) => new Date(now - hours * 3600_000).toISOString();
  const work = (state: "todo" | "doing" | "done", extra: Partial<PlanRow> = {}): PlanRow => ({ id: "work", text: "Work", state, ...(state === "doing" ? { since: at } : state === "done" ? { doneAt: at } : {}), ...extra } as PlanRow);
  const session = (started: string, role: "工程师" | "审查" = "工程师", ended?: string) => ({ agentId: "s1", agent: "eng", role, level: 2, model: "Sonnet", started, ...(ended ? { finish: { ended, result: "一次通过", ...(role === "工程师" ? { reports: 0, kickbacks: 0 } : { rounds: 1 }), signals: [], usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, cost: 0 } } : {}) });
  const wait: PlanRow = { id: "target", item: "target", own: false, after: [] };
  interface Case { name: string; plan: PlanRow[]; dispatches?: ReturnType<typeof session>[]; wrote?: string; expected: Status }
  const cases: Case[] = [
    { name: "nothing done and nobody on it", plan: [work("todo"), acceptance()], expected: "todo" },
    { name: "a row done, nobody on it", plan: [work("done"), acceptance()], expected: "stalled" },
    { name: "a row in progress", plan: [work("doing"), acceptance()], expected: "wip" },
    { name: "a dropped row is not progress", plan: [work("todo", { state: "dropped", reason: "No longer needed", droppedAt: at } as Partial<PlanRow>), acceptance()], expected: "todo" },
    { name: "nothing done, a session started an hour ago", plan: [work("todo"), acceptance()], dispatches: [session(ago(1))], expected: "wip" },
    { name: "nothing done, a session started seven hours ago and wrote nothing since", plan: [work("todo"), acceptance()], dispatches: [session(ago(7))], expected: "todo" },
    { name: "the same session wrote an hour ago", plan: [work("todo"), acceptance()], dispatches: [session(ago(7))], wrote: ago(1), expected: "wip" },
    { name: "a row done and a live session", plan: [work("done"), acceptance()], dispatches: [session(ago(2))], expected: "wip" },
    { name: "a row done and the session has ended", plan: [work("done"), acceptance()], dispatches: [session(ago(3), "工程师", ago(1))], expected: "stalled" },
    { name: "a live review holds the item too", plan: [work("done"), acceptance()], dispatches: [session(ago(1), "审查")], expected: "wip" },
    { name: "every row that could go next waits, session or not", plan: [wait, work("todo"), acceptance()], dispatches: [session(ago(1))], expected: "blocked" },
    { name: "waiting beside work that can start", plan: [wait, work("todo", { after: [] } as Partial<PlanRow>), acceptance()], expected: "todo" },
  ];
  for (const c of cases) {
    const s = fixture(c.plan);
    s.items.subject = Item.parse({ ...s.items.subject, ...(c.dispatches ? { dispatches: c.dispatches } : {}) });
    if (c.wrote) s.activity = { writes: [], items: {}, agents: { eng: [{ item: "elsewhere", at: c.wrote }] } };
    assert.equal(rules(s, now).statusOf("subject"), c.expected, `production: ${c.name}`);
    assert.equal(derivePlanOracle(s, undefined, now).statusOf("subject"), c.expected, `oracle: ${c.name}`);
  }
});

// The two cases that prompted the item, as the plans had them. Before the change both showed todo.
test("the item's two examples: a plan done but for two unheld parts is part way, and the PR stage with a live session is in progress", () => {
  const now = Date.parse("2026-10-17T12:00:00Z"), ago = (hours: number) => new Date(now - hours * 3600_000).toISOString();
  const done = (id: string, extra: Partial<PlanRow> = {}): PlanRow => ({ id, text: id, state: "done", doneAt: at, ...extra } as PlanRow);
  // A study, the work, the merge and the acceptance are done; two parts hung on later have nobody on them.
  const costs = Item.parse({
    title: "Cut the Actions minutes", group: "P", priority: "P0", updated: at, rev: 1,
    plan: [{ id: "study", item: "study", own: true, after: [] }, done("build", { after: ["study"] }), done("ship"), acceptance("done"), { id: "private", item: "private", own: true, after: ["accept"] }, { id: "usage", item: "usage", own: true, after: ["accept"] }],
  });
  const part = (title: string, state: "todo" | "done") => Item.parse({ title, group: "P", updated: at, rev: 1, plan: [acceptance(state)] });
  const first: Snapshot = { head: "0".repeat(40), board: { title: "Examples", projects: [{ name: "P" }] }, glossaries: {}, notes: {}, owner: {}, decisions: {},
    items: { costs, study: part("Study", "done"), private: part("Private content", "todo"), usage: part("Usage push", "todo") } };
  assert.equal(rules(first, now).statusOf("costs"), "stalled");
  assert.equal(derivePlanOracle(first, undefined, now).statusOf("costs"), "stalled");
  // The PR is ready: the implementation is done; the merge row is marked by the board and the acceptance by the architect.
  const session = (started: string) => ({ agentId: "e1", agent: "eng", role: "工程师" as const, level: 2, model: "Sonnet", started });
  const pr = (dispatches: ReturnType<typeof session>[], wrote?: string): Snapshot => ({
    head: "0".repeat(40), board: { title: "Examples", projects: [{ name: "P" }] }, glossaries: {}, notes: {}, owner: {}, decisions: {},
    items: { pr: Item.parse({ title: "Push blocks writes", group: "P", priority: "P0", updated: at, rev: 1, dispatches, plan: [done("impl"), { id: "ship", text: "合入", state: "todo" }, acceptance()] }) },
    ...(wrote ? { activity: { writes: [], items: {}, agents: { eng: [{ item: "elsewhere", at: wrote }] } } } : {}),
  });
  for (const [name, snap, expected] of [
    ["the engineer was started two hours ago", pr([session(ago(2))]), "wip"],
    ["started seven hours ago and wrote an hour ago", pr([session(ago(7))], ago(1)), "wip"],
    ["started seven hours ago and wrote nothing since", pr([session(ago(7))]), "stalled"],
    ["no dispatch record at all", pr([]), "stalled"],
  ] as const) {
    assert.equal(rules(snap, now).statusOf("pr"), expected, `production: ${name}`);
    assert.equal(derivePlanOracle(snap, undefined, now).statusOf("pr"), expected, `oracle: ${name}`);
  }
});

// "Part done" is the item's own work: its steps, and the items it owns. What others finished (a shared dependency, a ruled card,
// a shared record) is not, though the progress count still includes those rows.
test("status table: only the item's own work makes it part way", () => {
  const step: PlanRow = { id: "work", text: "Work", state: "todo", after: [] };
  const cases: Array<{ name: string; plan: PlanRow[]; target?: Partial<Item>; card?: "ruled"; expected: Status }> = [
    { name: "a shared dependency is done", plan: [{ id: "target", item: "target", own: false, after: [] }, step, acceptance()], target: { plan: [acceptance("done")] }, expected: "todo" },
    { name: "a shared record", plan: [{ id: "target", item: "target", own: false, after: [] }, step, acceptance()], target: { record: true, plan: [] }, expected: "todo" },
    { name: "a card is ruled", plan: [{ id: "q", card: "q", after: [] }, step, acceptance()], card: "ruled", expected: "todo" },
    { name: "an owned item is done", plan: [{ id: "target", item: "target", own: true, after: [] }, step, acceptance()], target: { plan: [acceptance("done")] }, expected: "stalled" },
    { name: "an own step is done", plan: [{ ...step, state: "done", doneAt: at } as PlanRow, acceptance()], expected: "stalled" },
  ];
  for (const c of cases) {
    const s = fixture(c.plan, c.target, c.card);
    assert.equal(rules(s).statusOf("subject"), c.expected, `production: ${c.name}`);
    assert.equal(derivePlanOracle(s).statusOf("subject"), c.expected, `oracle: ${c.name}`);
  }
});

test("status table: an owned item waits for the rows before its row, and part way reaches the owner", () => {
  const step = (id: string, state: "todo" | "done", extra: Partial<PlanRow> = {}): PlanRow => ({ id, text: id, state, ...(state === "done" ? { doneAt: at } : {}), ...extra } as PlanRow);
  const owns = (extra: Partial<PlanRow> = {}): PlanRow => ({ id: "subject", item: "subject", own: true, ...extra } as PlanRow);
  const cases: Array<{ name: string; owner: PlanRow[]; record?: boolean; subject?: PlanRow[]; expected: Status; ownerExpected?: Status }> = [
    { name: "the row before it is still to do", owner: [step("first", "todo"), owns(), acceptance()], expected: "blocked" },
    { name: "the row before it is done", owner: [step("first", "done"), owns(), acceptance()], expected: "todo" },
    { name: "its row comes after nothing", owner: [step("first", "todo"), owns({ after: [] }), acceptance()], expected: "todo" },
    { name: "its row comes after a row that is done, though an earlier one is not", owner: [step("first", "todo"), step("second", "done", { after: [] }), owns({ after: ["second"] }), acceptance()], expected: "todo" },
    { name: "its row is first", owner: [owns(), acceptance()], expected: "todo" },
    { name: "a record's rows are a list, not an order", owner: [step("first", "todo") as PlanRow, owns()], record: true, expected: "todo" },
    { name: "part way below makes the owner part way", owner: [owns(), acceptance()], subject: [step("work", "done"), acceptance()], expected: "stalled", ownerExpected: "stalled" },
    { name: "nothing done below leaves the owner untouched", owner: [owns(), acceptance()], expected: "todo", ownerExpected: "todo" },
  ];
  for (const c of cases) {
    const s = fixture(c.subject ?? [step("work", "todo"), acceptance()]);
    // The fixture's "subject" is the item under test; "owner" is added above it.
    s.items.owner = Item.parse({ title: "Owner", group: "P", plan: c.owner, ...(c.record ? { record: true } : {}), updated: at, rev: 1 });
    if (c.record) s.items.owner = Item.parse({ title: "Backlog", group: "P", record: true, plan: c.owner.filter(row => "item" in row), updated: at, rev: 1 });
    assert.equal(rules(s).statusOf("subject"), c.expected, `production: ${c.name}`);
    assert.equal(derivePlanOracle(s).statusOf("subject"), c.expected, `oracle: ${c.name}`);
    if (c.ownerExpected) {
      assert.equal(rules(s).statusOf("owner"), c.ownerExpected, `production owner: ${c.name}`);
      assert.equal(derivePlanOracle(s).statusOf("owner"), c.ownerExpected, `oracle owner: ${c.name}`);
    }
  }
});

test("status table: owned items each waiting on the other's earlier row stay blocked in both derivations", () => {
  const todo = (id: string, extra: Partial<PlanRow>): PlanRow => ({ id, ...extra } as PlanRow);
  const s: Snapshot = {
    head: "0".repeat(40), board: { title: "Cross", projects: [{ name: "P" }] }, glossaries: {}, notes: {}, owner: {}, decisions: {},
    items: {
      y: Item.parse({ title: "Y", group: "P", priority: "P1", updated: at, rev: 1, plan: [todo("w", { item: "w", own: false, after: [] }), todo("c", { item: "c", own: true, after: ["w"] }), acceptance()] }),
      v: Item.parse({ title: "V", group: "P", priority: "P1", updated: at, rev: 1, plan: [todo("c", { item: "c", own: false, after: [] }), todo("w", { item: "w", own: true, after: ["c"] }), acceptance()] }),
      c: Item.parse({ title: "C", group: "P", updated: at, rev: 1, plan: [acceptance()] }), w: Item.parse({ title: "W", group: "P", updated: at, rev: 1, plan: [acceptance()] }),
    },
  };
  for (const id of ["c", "w"]) {
    assert.equal(rules(s).statusOf(id), "blocked", `production ${id}`);
    assert.equal(derivePlanOracle(s).statusOf(id), "blocked", `oracle ${id}`);
  }
});

test("status table: a pause marker holds the item and what it owns in its project, and a paused part leaves its owner waiting", () => {
  const paused = { reason: "Hold", at };
  const owned = (item: string, extra: Partial<PlanRow> = {}): PlanRow => ({ id: item, item, own: true, after: [], ...extra } as PlanRow);
  const work = (): PlanRow => ({ id: "work", text: "Work", state: "todo", after: [] });
  const item = (group: string, plan: PlanRow[], extra: Partial<Item> = {}) => Item.parse({ title: "T", group, priority: "P1", updated: at, rev: 1, plan, ...extra });
  const s: Snapshot = {
    head: "0".repeat(40), board: { title: "Pause", projects: [{ name: "P" }, { name: "Q" }] }, glossaries: {}, notes: {}, owner: {}, decisions: {},
    items: {
      top: item("P", [owned("held"), owned("freeKid"), acceptance()]),
      held: item("P", [owned("heldKid"), owned("otherProject"), acceptance()], { paused }),
      heldKid: item("P", [work(), acceptance()]),
      otherProject: item("Q", [work(), acceptance()]),
      freeKid: item("P", [work(), acceptance()]),
      // Only ready row is a paused part: the owner waits.
      waiter: item("P", [owned("pausedPart"), acceptance()]),
      pausedPart: item("P", [work(), acceptance()], { paused }),
    },
  };
  const expected: Record<string, Status> = { held: "paused", heldKid: "paused", otherProject: "todo", freeKid: "todo", top: "todo", waiter: "blocked", pausedPart: "paused" };
  for (const [id, status] of Object.entries(expected)) {
    assert.equal(rules(s).statusOf(id), status, `production ${id}`);
    assert.equal(derivePlanOracle(s).statusOf(id), status, `oracle ${id}`);
  }
});
