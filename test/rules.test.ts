import assert from "node:assert/strict";
import test from "node:test";
import { Decision, Item, PlanStep, PlanStepInput, PlanRow, PlanRowInput, PlanInput, ItemPlan, Project, ItemTarget, ItemTargetInput, Note } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { rules, affectedItems, presentationSignature, changedItemPlan, planChanged, stampPlanRow, changedItemTargets, targetsChanged, stampItemTarget, targetLine, checkLabel, cardMarker, placedCards, CARD_UNPLACED_LABEL, CARD_MISMATCH_LABEL, STALLED_LABEL, WAITS_TEXT_LABEL, withoutHistoricalDetail, isLogChange } from "../src/rules.ts";

const T0 = "2026-10-10T00:00:00Z", T1 = "2026-10-11T00:00:00Z", T2 = "2026-10-12T00:00:00Z";
const step = (id = "work", state: PlanStep["state"] = "todo", fields: Partial<PlanStep> = {}): PlanStep => ({ id, text: id, state, ...(state === "done" ? { doneAt: T0 } : state === "doing" ? { since: T0 } : state === "dropped" ? { droppedAt: T0, reason: "Replaced" } : {}), ...fields });
const accept = (state: PlanStep["state"] = "todo") => step("accept", state, { accept: true, text: "Checks pass" });
const own = (item: string, after: string[] = []): PlanRow => ({ id: item, item, own: true, after });
const shared = (item: string, after: string[] = []): PlanRow => ({ id: item, item, own: false, after });
const card = (key: string, after: string[] = []): PlanRow => ({ id: key, card: key, after });
const workPlan = (rows: PlanRow[] = [], state: PlanStep["state"] = "todo") => [...rows, accept(state)];
function snapshot(items: Record<string, Partial<Item>>, decisions: Record<string, Partial<Decision>> = {}, notes: Record<string, Partial<Note>> = {}): Snapshot {
  return {
    board: { title: "Synthetic", projects: ["Default", "First", "Second"].map(name => ({ name })) }, head: "0".repeat(40), glossaries: {}, owner: {},
    items: Object.fromEntries(Object.entries(items).map(([id, fields]) => [id, Item.parse({ title: id, group: "Default", priority: "P2", ...(fields.record ? {} : { difficulty: 2 }), plan: fields.record ? [] : workPlan([step()]), updated: T0, rev: 1, ...fields })])),
    decisions: Object.fromEntries(Object.entries(decisions).map(([id, fields]) => [id, Decision.parse({ item: "area", question: id, options: [{ key: "A", text: "choose" }], status: "open", updated: T0, rev: 1, ...fields })])),
    notes: Object.fromEntries(Object.entries(notes).map(([id, fields]) => [id, Note.parse({ target: "it:area", kind: "comment", text: "note", at: T0, state: "sent", rev: 1, ...fields })])),
  };
}
const texts = (s: Snapshot, id: string) => rules(s).checks(id).map(c => c.text);

test("cards belong to decision.item and follow its plan, then the cards with no row, regardless of status", () => {
  const r = rules(snapshot({ a: { plan: workPlan([card("second"), card("first"), card("other")]) }, b: { plan: workPlan([card("withdrawn")]) } }, {
    first: { item: "a", status: "ruled" }, second: { item: "a" }, other: { item: "b" },
    withdrawn: { item: "b", status: "withdrawn" }, orphan: { item: "a" },
  }));
  // The row `other` in a's plan names a card of b, so it is not a's card; `orphan` has no row and comes last.
  assert.deepEqual(r.cardsOf("a"), ["second", "first", "orphan"]);
  assert.deepEqual(r.cardsOf("b"), ["withdrawn", "other"]);
  assert.equal(r.needsOwner("a"), true);
  assert.equal(r.needsOwner("b"), true);
  assert.equal(rules(snapshot({ b: { plan: workPlan([card("withdrawn")]) } }, { withdrawn: { item: "b", status: "withdrawn" } })).needsOwner("b"), false, "a withdrawn card waits for no one");
});

test("asks require an exact page answer prefix and a sent or done note on the item", () => {
  for (const kind of ["approve", "done"] as const) for (const state of ["draft", "sent", "done"] as const) {
    const text = (kind === "approve" ? "同意：" : "已完成：") + "merge";
    const r = rules(snapshot({ a: { ask: { text: "merge", url: "https://example.com/pr", chat: true } } }, {}, { n: { target: "it:a", kind, state, text } }));
    assert.equal(r.needsOwner("a"), state === "draft", `${kind}/${state}`);
  }
  for (const note of [
    { kind: "approve" as const, text: "批准：merge" }, { kind: "approve" as const, text: "同意：merge " },
    { kind: "comment" as const, text: "同意：merge" }, { kind: "approve" as const, text: "同意：merge", target: "it:other" },
  ]) assert.equal(rules(snapshot({ a: { ask: { text: "merge" } } }, {}, { n: { target: "it:a", ...note } })).needsOwner("a"), true);
  assert.equal(rules(snapshot({ a: {} })).needsOwner("a"), false);
});

test("an open card waits for the owner whatever notes it has; a closed card does not", () => {
  for (const status of ["open", "ruled", "withdrawn"] as const) for (const state of ["draft", "sent", "done"] as const) {
    const r = rules(snapshot({ a: {} }, { q: { item: "a", status } }, { n: { target: "q:q", kind: "choice", state } }));
    assert.equal(r.needsOwner("a"), status === "open", `${status}/${state}`);
  }
  const r = rules(snapshot({ a: { ask: { text: "merge" } } }, { q: { item: "a" } }, { n: { target: "q:q", kind: "comment" } }));
  assert.equal(r.needsOwner("a"), true);
  const answered = rules(snapshot({ a: { ask: { text: "merge" } } }, { q: { item: "a" } }, { n: { target: "it:a", kind: "approve", text: "同意：merge" } }));
  assert.equal(answered.needsOwner("a"), true); // answered ask does not answer card
});


test("schema permits only the plan shape, project identity and cancellation status", () => {
  const base = { title: "Work", group: "Default", updated: T0, rev: 1, plan: workPlan() };
  assert.equal(Item.safeParse(base).success, true);
  assert.equal(Item.safeParse({ ...base, status: "cancelled" }).success, true);
  for (const status of ["todo", "wip", "blocked", "done"]) assert.equal(Item.safeParse({ ...base, status }).success, false);
  for (const field of ["parent", "deps", "steps", "migrated"]) assert.equal(Item.safeParse({ ...base, [field]: [] }).success, false);
  assert.equal(Item.safeParse({ ...base, group: undefined }).success, false);
  assert.equal(Item.safeParse({ ...base, plan: [] }).success, false);
  assert.equal(Item.safeParse({ ...base, record: true }).success, false, "records cannot accept work");
  assert.equal(Item.safeParse({ ...base, record: true, plan: [] }).success, true);
  assert.equal(Item.safeParse({ ...base, record: true, plan: [], status: "cancelled" }).success, false);
  assert.equal(Project.safeParse({ name: "Default", migrated: true }).success, false);
});

test("row schemas refuse forged ids, target metadata and dates from callers, while acceptance takes ordinary step fields", () => {
  const id = "x";
  assert.equal(PlanRowInput.safeParse({ item: id, own: true }).success, true);
  assert.equal(PlanRowInput.safeParse({ card: id }).success, true);
  assert.equal(PlanRowInput.safeParse({ item: id, own: true, id }).success, false);
  assert.equal(PlanRow.safeParse({ item: id, own: true, id: "wrong" }).success, false);
  assert.equal(PlanRow.safeParse({ card: id, id: "wrong" }).success, false);
  for (const extra of [{ why: "old explanation" }, { state: "todo" }, { since: T0 }]) assert.equal(PlanRow.safeParse({ ...own(id), ...extra }).success, false);
  for (const extra of [{ after: [] }, { waits: "CI" }]) assert.equal(PlanStepInput.safeParse({ ...accept(), ...extra }).success, true);
  for (const [state, field] of [["done", "doneAt"], ["doing", "since"], ["dropped", "droppedAt"]] as const) {
    const input = { id, text: "Result", state, ...(state === "dropped" ? { reason: "Replaced" } : {}) };
    assert.equal(PlanStepInput.safeParse(input).success, true);
    assert.equal(PlanStep.safeParse(input).success, false);
    assert.equal(PlanStep.safeParse({ ...input, [field]: T0 }).success, true);
    assert.equal(PlanStepInput.safeParse({ ...input, [field]: T0 }).success, false);
  }
  assert.equal(PlanStepInput.safeParse({ id, text: " ", state: "todo" }).success, false);
  assert.equal(PlanStepInput.safeParse({ id, text: "Result", state: "dropped", reason: " " }).success, false);
  const prose = step(id, "dropped", { text: "  Exact text  ", reason: "  Exact reason  ", waits: "  Exact wait  " });
  assert.deepEqual(PlanStep.parse(prose), prose);
});

test("plans enforce unique ids and earlier-only after, with acceptance anywhere and several allowed", () => {
  const valid = [shared("dep"), step("work", "todo", { after: ["dep"] }), accept()];
  assert.equal(ItemPlan.safeParse(valid).success, true);
  for (const rows of [
    [step("work", "todo", { after: ["later"] }), shared("later"), accept()],
    [step("work", "todo", { after: ["work"] }), accept()],
    [step("dep"), shared("dep"), accept()],
    [shared("same"), card("same"), accept()],
  ]) assert.equal(ItemPlan.safeParse(rows).success, false);
  for (const rows of [[accept(), step("merge")], [accept(), { ...accept(), id: "second-check" }]]) {
    assert.equal(ItemPlan.safeParse(rows).success, true);
    assert.equal(Item.safeParse({ title: "Work", group: "Default", updated: T0, rev: 1, plan: rows }).success, true);
  }
  assert.equal(ItemPlan.safeParse([accept(), accept()]).success, false, "multiple acceptance rows still need unique ids");
  assert.equal(PlanInput.safeParse([{ item: "dep", own: false }, { id: "work", text: "Work", state: "todo", after: ["dep"] }]).success, true);
  assert.equal(PlanInput.safeParse([{ id: "work", text: "Work", state: "todo", after: ["dep"] }, { item: "dep", own: false }]).success, false);
});

test("ownership builds the tree in plan order and does not follow shared rows or child order", () => {
  const s = snapshot({ root: { group: "First", plan: workPlan([own("later"), own("earlier"), shared("foreign")]) }, later: { group: "First", order: 9 }, earlier: { group: "First", order: -9, plan: workPlan([own("leaf")]) }, leaf: { group: "First" }, foreign: { group: "Second" }, recordOwner: { record: true, plan: [own("record")] }, record: { record: true } });
  const r = rules(s);
  assert.deepEqual(r.children("root"), ["later", "earlier"]);
  assert.equal(r.parentOf("foreign"), undefined);
  assert.deepEqual(r.ancestors("leaf"), ["earlier", "root"]);
  assert.equal(r.lineOf("leaf"), "root"); assert.equal(r.projectOf("leaf"), "First");
  assert.equal(r.isLeaf("root"), false); assert.equal(r.isLeaf("recordOwner"), true); assert.equal(r.isStatusLeaf("recordOwner"), true);
  assert.deepEqual(r.areas(), ["recordOwner", "root", "foreign"]);
  assert.equal(r.statusOf("absent"), undefined); assert.equal(r.isRoot("absent"), false);
  assert.deepEqual(r.depsOf("absent"), []); assert.deepEqual(r.checks("absent"), []);
  assert.deepEqual(r.dependents("foreign"), [{ id: "root", own: false }]);
  assert.equal(r.item("constructor"), undefined);
});

test("status derives from all plan rows and distinguishes the frontier from later work", () => {
  const s = snapshot({
    todo: {}, doing: { plan: workPlan([step("work", "doing", { waits: "CI" })]) }, done: { plan: workPlan([step("work", "done")], "done") }, cancelled: { status: "cancelled" },
    blocked: { plan: workPlan([shared("todo"), step("work", "todo", { after: ["todo"] })]) },
    canMove: { plan: workPlan([shared("todo"), step("work", "todo", { after: [] })]) },
    ownsDoing: { plan: workPlan([own("doing")]) }, sharesDoing: { plan: workPlan([shared("doing")]) },
    acceptanceOnly: { plan: workPlan() }, completedParts: { plan: workPlan([own("done"), own("cancelled")]) },
    legacyAsk: { ask: { text: "Approve" } }, record: { record: true, plan: [own("todo")] },
  });
  const r = rules(s);
  for (const [id, expected] of Object.entries({ todo: "todo", doing: "wip", done: "done", cancelled: "cancelled", blocked: "blocked", canMove: "todo", ownsDoing: "wip", sharesDoing: "blocked", acceptanceOnly: "todo", completedParts: "todo", legacyAsk: "blocked" })) assert.equal(r.statusOf(id), expected, id);
  assert.equal(r.statusOf("record"), undefined);
  assert.deepEqual(r.planRows("blocked").map(row => row.ready), [true, false, false]);
  assert.deepEqual(r.planRows("canMove").map(row => row.ready), [true, true, false]);
  assert.deepEqual(r.planRows("completedParts").map(row => [row.state, row.dropped, row.excluded]), [["resolved", false, false], ["resolved", true, true], ["open", false, false]]);
});

test("pause schema retains its reason and server time and refuses records or malformed pauses", () => {
  const base = { title: "Work", group: "Default", updated: T0, rev: 1, plan: workPlan() };
  assert.deepEqual(Item.parse({ ...base, paused: { reason: "Owner deferred this release", at: T1 } }).paused, { reason: "Owner deferred this release", at: T1 });
  for (const paused of [{ reason: "", at: T1 }, { reason: " \n ", at: T1 }, { reason: "Deferred" }, { reason: "Deferred", at: "yesterday" }, { reason: "Deferred", at: T1, author: "Forged" }]) {
    assert.equal(Item.safeParse({ ...base, paused }).success, false);
  }
  assert.equal(Item.safeParse({ ...base, record: true, plan: [], paused: { reason: "Deferred", at: T1 } }).success, false);
});

test("pause inherits only through same-project ownership and resuming preserves every plan state", () => {
  const s = snapshot({
    root: { plan: workPlan([own("doing"), own("todo"), own("finished"), own("cancelled"), own("record"), own("foreign"), shared("external")]) },
    doing: { plan: workPlan([step("work", "doing"), own("nested")]) }, nested: {}, todo: {},
    finished: { plan: workPlan([], "done") }, cancelled: { status: "cancelled" },
    record: { record: true, plan: [own("underRecord")] }, underRecord: {},
    foreign: { group: "Second", plan: workPlan([step("work", "doing")]) }, external: { group: "Second" },
  });
  const before = rules(s), statuses = Object.fromEntries(Object.keys(s.items).map(id => [id, before.statusOf(id)]));
  const plans = Object.fromEntries(Object.entries(s.items).map(([id, it]) => [id, structuredClone(it.plan)]));
  // Assign after parsing so an old schema failure cannot hide a derivation regression.
  s.items.root!.paused = { reason: "Release postponed", at: T1 };
  const paused = rules(s);
  for (const id of ["root", "doing", "nested", "todo", "underRecord"]) {
    assert.equal(paused.statusOf(id), "paused", id);
    assert.equal(paused.pausedBy(id), "root", id);
    assert.equal(paused.isOpenWork(id), true, "paused work remains open for ownership checks");
  }
  assert.equal(paused.statusOf("finished"), "done");
  assert.equal(paused.statusOf("cancelled"), "cancelled");
  assert.equal(paused.statusOf("record"), undefined);
  assert.equal(paused.statusOf("foreign"), "wip", "invalid cross-project ownership cannot transmit pause");
  assert.equal(paused.statusOf("external"), "todo", "shared references cannot transmit pause");
  s.items.nested!.paused = { reason: "Independent pause", at: T2 };
  delete s.items.root!.paused;
  assert.equal(rules(s).statusOf("nested"), "paused", "resuming an ancestor preserves a child's own pause");
  assert.equal(rules(s).pausedBy("nested"), "nested");
  delete s.items.nested!.paused;
  const resumed = rules(s);
  for (const [id, it] of Object.entries(s.items)) {
    assert.deepEqual(it.plan, plans[id], id);
    assert.equal(resumed.statusOf(id), statuses[id], id);
  }
});

test("closed rows win over explicit pause and paused child rows wait for the owner", () => {
  const s = snapshot({ parent: { plan: workPlan([own("child")]) }, child: { plan: workPlan([step("work", "doing")]) }, done: { plan: workPlan([], "done") }, cancelled: { status: "cancelled" } });
  for (const id of ["child", "done", "cancelled"]) s.items[id]!.paused = { reason: "Owner pause", at: T1 };
  const r = rules(s);
  assert.equal(r.statusOf("parent"), "blocked");
  assert.equal(r.statusOf("child"), "paused");
  assert.equal(r.statusOf("done"), "done"); assert.equal(r.statusOf("cancelled"), "cancelled");
  assert.equal(r.isPaused("done"), false); assert.equal(r.isPaused("cancelled"), false);
  assert.deepEqual(r.planRows("parent").map(row => [row.state, row.ready, row.glyph]), [["waiting", true, "◌"], ["open", false, "○"]]);
  assert.deepEqual(r.checks("child").filter(check => check.label === "暂停冲突"), [], "ownership alone waits without a pause conflict");
});

test("a paused child conflicts with shared dependents but not its unpaused owner", () => {
  const s = snapshot({ parent: { plan: workPlan([own("child")]) }, child: {}, dependent: { priority: "P0", plan: workPlan([shared("child")]) } });
  s.items.child!.paused = { reason: "Owner paused this part", at: T1 };
  const r = rules(s);
  assert.equal(r.statusOf("parent"), "blocked", "the owning row still waits for the owner's resumption");
  assert.deepEqual(r.checks("child").filter(check => check.label === "暂停冲突"), [{ label: "暂停冲突", text: "暂停了，但 dependent 在等它", target: { kind: "item", id: "dependent" } }], "the shared dependent retains its conflict even when the target is owned");
});

test("paused roots retain their priority and rootness but propagate none to owned or shared work", () => {
  const s = snapshot({ root: { priority: "P2", plan: workPlan([own("child"), shared("foreign")]) }, child: { plan: workPlan([shared("further")]) }, foreign: { group: "Second" }, further: { group: "Second" } });
  s.items.root!.paused = { reason: "Owner postponed release", at: T1 };
  const r = rules(s);
  assert.equal(r.isRoot("root"), true); assert.equal(r.priorityOf("root"), "P2");
  for (const id of ["child", "foreign", "further"]) {
    assert.equal(r.isRoot(id), false, "pausing a dependent does not promote its targets to roots");
    assert.equal(r.priorityOf(id), "", id);
  }
  delete s.items.root!.paused;
  const resumed = rules(s);
  for (const id of ["root", "child", "foreign", "further"]) assert.equal(resumed.priorityOf(id), "P2", id);
});

test("unpaused shared P0 dependents flag conflicts on paused targets and still give them priority", () => {
  const s = snapshot({ paused: { group: "Second", plan: workPlan([shared("beyond")]) }, beyond: { group: "Second" }, urgent: { priority: "P0", plan: workPlan([shared("paused")]) }, other: { plan: workPlan([shared("paused")]) }, closed: { status: "cancelled", plan: workPlan([shared("paused")]) } });
  s.items.paused!.paused = { reason: "Stopped", at: T1 };
  s.items.other!.paused = { reason: "Also stopped", at: T1 };
  const r = rules(s);
  assert.equal(r.priorityOf("paused"), "P0", "pause does not hide priority supplied by unpaused work");
  assert.equal(r.priorityOf("beyond"), "", "the paused target cannot pass its incoming priority onward");
  assert.deepEqual(r.checks("paused").filter(check => check.label === "暂停冲突"), [{ label: "暂停冲突", text: "暂停了，但 urgent 在等它", target: { kind: "item", id: "urgent" } }]);
  assert.equal(r.checks("urgent").some(check => check.label === "暂停冲突"), false, "the warning belongs to the paused target");
  s.items.urgent!.paused = { reason: "Owner also stopped waiter", at: T2 };
  assert.equal(rules(s).checks("paused").some(check => check.label === "暂停冲突"), false);
});

test("cards and missing targets wait, and only closing the card resolves its row", () => {
  const s = snapshot({ waiter: { plan: workPlan([card("q")]) }, missing: { plan: workPlan([shared("gone")]) }, missingCard: { plan: workPlan([card("gone-card")]) } }, { q: { item: "waiter" } }, { choice: { target: "q:q", kind: "choice", state: "sent" } });
  const r = rules(s);
  assert.equal(r.cardWaiting("q"), true, "a choice note on an open card does not close it"); assert.equal(r.statusOf("waiter"), "blocked");
  for (const id of ["missing", "missingCard"]) { assert.equal(r.statusOf(id), "blocked"); assert.equal(r.depsOf(id)[0]!.open, true); assert.equal(r.depsOf(id)[0]!.missing, true); }
  assert.deepEqual(r.cardDependents("q"), [{ id: "waiter" }]);
  for (const status of ["ruled", "withdrawn"] as const) { s.decisions.q!.status = status; assert.equal(rules(s).planRows("waiter")[0]!.state, "resolved"); assert.equal(rules(s).statusOf("waiter"), "todo"); }
});

test("row ratios exclude dropped steps, cancelled owned work and owned records, while shared records count", () => {
  const s = snapshot({ item: { plan: workPlan([step("done", "done"), step("dropped", "dropped"), own("cancelled"), own("ownedRecord"), shared("sharedRecord"), shared("cancelled-shared")]) }, cancelled: { status: "cancelled" }, ownedRecord: { record: true }, sharedRecord: { record: true }, "cancelled-shared": { status: "cancelled" } });
  const r = rules(s);
  assert.deepEqual(r.planRatio("item"), { done: 2, total: 4 });
  assert.deepEqual(r.planRows("item").map(row => row.glyph), ["✓", "✗", "✗", "✓", "✓", "⏸", "○"]);
  assert.equal(r.statusOf("item"), "blocked");
  assert.ok(texts(s, "item").includes("依赖的条目已取消"));
  assert.deepEqual(r.planRatio("ownedRecord"), { done: 0, total: 0 });
});

test("after defaults chain only the previous row, including acceptance", () => {
  const s = snapshot({ a: { plan: workPlan([shared("dep"), step("independent", "done", { after: [] }), step("next")]) }, dep: {} });
  const rows = rules(s).planRows("a");
  assert.deepEqual(rows.map(row => row.level), [0, 0, 1, 2]);
  assert.deepEqual(rows.map(row => row.ready), [true, false, true, false]);
  assert.deepEqual(rules(s).planGroups("a"), [{ start: 0, end: 2, level: 0 }]);
  const split = snapshot({ a: { record: true, plan: [step("a"), step("b"), step("c", "todo", { after: [] }), step("d", "todo", { after: [] }), step("e"), step("f", "todo", { after: [] })] } });
  assert.deepEqual(rules(split).planGroups("a"), [{ start: 2, end: 4, level: 0 }]);
  s.items.a!.plan = [shared("dep"), step("checked", "done", { after: [] }), accept()];
  assert.deepEqual(rules(s).planRows("a").map(row => row.ready), [true, false, true], "acceptance follows its previous row, not the unrelated wait");
  assert.deepEqual(rules(s).planRows("a").map(row => row.level), [0, 0, 1]);
});

test("acceptance readiness and parallel groups follow only its ordinary after rows", () => {
  const s = snapshot({ a: {}, dep: {} });
  // Assign stored rows directly so the old acceptance-field schema cannot hide
  // a frontier bug behind an earlier parser rejection.
  s.items.a!.plan = [shared("dep"), step("checked", "done", { after: [] }), { ...accept(), after: ["checked"] }, step("merge")];
  const r = rules(s);
  assert.deepEqual(r.planRows("a").map(row => row.ready), [true, false, true, false]);
  assert.deepEqual(r.planRows("a").map(row => row.level), [0, 0, 1, 2]);
  s.items.a!.plan[2] = { ...accept(), after: ["dep"] };
  assert.equal(rules(s).planRows("a")[2]!.ready, false, "a named unresolved prerequisite still blocks acceptance");
  s.items.a!.plan = [step("work"), { ...accept(), after: [] }, { ...accept(), id: "scenario", after: [] }];
  assert.deepEqual(rules(s).planGroups("a"), [{ start: 0, end: 3, level: 0 }], "acceptance participates in ordinary parallel groups");
});

test("completed acceptance before delivery does not complete the item or raise a false check", () => {
  const s = snapshot({ a: {} });
  s.items.a!.plan = [step("work", "done"), accept("done"), step("merge")];
  const r = rules(s);
  assert.equal(r.statusOf("a"), "todo");
  assert.deepEqual(r.planRatio("a"), { done: 2, total: 3 });
  assert.deepEqual(r.checks("a"), []);
  s.items.a!.plan[2] = step("merge", "done");
  assert.equal(rules(s).statusOf("a"), "done");
  assert.deepEqual(rules(s).planRatio("a"), { done: 3, total: 3 });
});

test("only-acceptance and placeholder checks inspect every acceptance scenario", () => {
  const s = snapshot({ a: {} });
  s.items.a!.plan = [step("work", "done"), accept("done"), { ...accept(), id: "scenario", text: "（转换时没找到完成条件，待补）" }];
  assert.deepEqual(texts(s, "a"), ["验收步骤待补", "只差验收：其它行都已完成"]);
  assert.deepEqual(rules(s).planRatio("a"), { done: 2, total: 3 });
  s.items.a!.plan.push(step("merge"));
  assert.deepEqual(texts(s, "a"), ["验收步骤待补"], "unfinished delivery prevents an only-acceptance check");
  s.items.a!.plan[2] = step("scenario", "dropped", { accept: true });
  s.items.a!.plan[3] = step("merge", "done");
  assert.deepEqual(texts(s, "a"), []);
  assert.equal(rules(s).statusOf("a"), "done");
  assert.deepEqual(rules(s).planRatio("a"), { done: 3, total: 3 }, "dropped acceptance is excluded like a dropped step");
});

test("priority flows across owned and shared item rows, including across projects, but not card rows", () => {
  const s = snapshot({ far: { group: "Second", priority: "P2" }, mid: { plan: workPlan([shared("far")]) }, root: { priority: "P1", plan: workPlan([own("mid")]) }, urgent: { priority: "P0", plan: workPlan([shared("far"), card("q")]) }, host: {} }, { q: { item: "urgent" } });
  const r = rules(s);
  assert.equal(r.priorityOf("mid"), "P1"); assert.equal(r.priorityOf("far"), "P0"); assert.equal(r.priorityOf("host"), "P2");
  assert.equal(r.isRoot("mid"), false); assert.equal(r.isRoot("far"), false); assert.equal(r.isRoot("root"), true);
});

test("record-owned work receives shared dependents priority, never the record or its stored priority", () => {
  const s = snapshot({ queue: { record: true, priority: "P0", plan: [own("run"), own("closed")] }, run: { priority: "P1", plan: workPlan([shared("beyond")]) }, closed: { priority: "P1", plan: workPlan([], "done") }, beyond: { priority: undefined }, urgent: { priority: "P0", plan: workPlan([shared("run")]) } });
  const r = rules(s);
  assert.equal(r.isBacklog("run"), true); assert.equal(r.isRoot("run"), false); assert.equal(r.priorityOf("run"), "P0"); assert.equal(r.priorityOf("beyond"), "P0");
  assert.ok(!texts(s, "run").includes("没有未完成的条目依赖它，却没写优先级"));
  assert.equal(r.isBacklog("closed"), false); assert.equal(r.isRoot("closed"), true); assert.equal(r.priorityOf("closed"), "P1");
  s.items.urgent!.plan = workPlan([], "done");
  const noWaiter = rules(s);
  assert.equal(noWaiter.priorityOf("run"), ""); assert.equal(noWaiter.priorityOf("beyond"), "");
  assert.equal(noWaiter.isRoot("run"), false);
  s.items.queue!.plan = [own("closed")]; s.items.urgent!.plan = workPlan([own("run")]);
  const moved = rules(s); assert.equal(moved.isBacklog("run"), false); assert.equal(moved.priorityOf("run"), "P0"); assert.equal(moved.priorityOf("beyond"), "P0");
});

test("records and closed work pass no priority, but closed targets keep incoming priority", () => {
  const s = snapshot({ root: { priority: "P0", plan: workPlan([own("record"), own("finished")]) }, record: { record: true, plan: [shared("far")] }, finished: { priority: "P2", plan: workPlan([shared("far")], "done") }, far: { plan: workPlan([], "done") } });
  const r = rules(s);
  assert.equal(r.priorityOf("record"), "P0"); assert.equal(r.priorityOf("finished"), "P0"); assert.equal(r.priorityOf("far"), "P2");
});

test("cycles terminate, identify only members, and receive priority only from outside open work", () => {
  const s = snapshot({ a: { priority: "P0", plan: workPlan([own("b")]) }, b: { priority: "P1", plan: workPlan([own("a")]) }, self: { plan: workPlan([shared("self")]) }, missing: { plan: workPlan([shared("gone")]) } });
  const r = rules(s);
  for (const id of ["a", "b", "self"]) { assert.equal(r.onCycle(id), true); assert.equal(r.priorityOf(id), ""); assert.equal(r.statusOf(id), "blocked"); }
  assert.deepEqual(r.ancestors("a"), ["b"]); assert.equal(r.onCycle("missing"), false);
  s.items.waiter = Item.parse({ title: "Waiter", group: "Default", priority: "P1", plan: workPlan([shared("a")]), updated: T0, rev: 1 });
  const reached = rules(s); assert.equal(reached.onCycle("waiter"), false); assert.equal(reached.priorityOf("a"), "P1"); assert.equal(reached.priorityOf("b"), "P1");
});

test("cancelled items get no checks, including their cards; open items keep theirs", () => {
  const s = snapshot({ gone: { status: "cancelled", plan: workPlan() }, stale: { status: "cancelled", provisional: true, plan: workPlan([step()]) }, placeholder: { status: "cancelled", plan: [step("work", "done"), { ...accept(), text: "（转换时没找到完成条件，待补）" }] }, untagged: { status: "cancelled", plan: workPlan() }, open: { plan: workPlan() } }, { card: { item: "gone" } });
  s.board.tags = [{ name: "看板", meaning: "board work" }];
  for (const id of ["gone", "stale", "placeholder", "untagged"]) assert.deepEqual(texts(s, id), [], id);
  assert.deepEqual(rules(s).cardChecks("card"), [], "a card of a cancelled item");
  assert.ok(texts(s, "open").includes("只差验收：其它行都已完成"));
  assert.ok(texts(s, "open").some(text => text.startsWith("缺标签")));
});

test("plan checks flag structural violations and conversion placeholders, without old manual-status checks", () => {
  const s = snapshot({ p: { plan: workPlan([own("x")]) }, second: { group: "Second", plan: workPlan([own("x")]) }, x: {}, loose: { priority: undefined }, waiter: { plan: workPlan([shared("loose")]) }, missing: { plan: workPlan([shared("gone"), card("gone-card")]) }, provisional: { provisional: true, plan: workPlan([step()]) }, placeholder: { plan: [step(), { ...accept(), text: "（转换时没找到完成条件，待补）" }] }, oldParent: { status: "cancelled", plan: workPlan([own("open")]) }, open: {}, onlyAcceptance: { plan: workPlan() }, acceptedEarly: { plan: workPlan([step()], "done") }, unconfigured: { group: "Unknown" }, rootMissing: { priority: undefined } });
  assert.ok(texts(s, "x").includes("被多个条目拥有")); assert.ok(texts(s, "x").includes("跨项目拥有"));
  assert.ok(texts(s, "loose").includes("同项目有条目在等它，却没有条目拥有它"));
  assert.deepEqual(texts(s, "missing"), ["依赖的条目不存在：gone", "依赖的决策卡不存在：gone-card"]);
  assert.ok(texts(s, "provisional").includes("计划待重写")); assert.equal(rules(s).checks("provisional").find(c => c.text === "计划待重写")!.label, "待重写");
  assert.ok(texts(s, "placeholder").includes("验收步骤待补")); assert.ok(texts(s, "open").includes("拥有它的条目已关闭"));
  assert.ok(texts(s, "onlyAcceptance").includes("只差验收：其它行都已完成")); assert.ok(!texts(s, "acceptedEarly").includes("验收已标完成，但还有行没完成"));
  assert.deepEqual(texts(s, "unconfigured"), ["项目没有配置：Unknown"]);
  assert.ok(texts(s, "rootMissing").includes("没有未完成的条目依赖它，却没写优先级"));
  const corrupt = structuredClone(s); corrupt.items.rootMissing!.plan = [];
  assert.ok(texts(corrupt, "rootMissing").includes("没有计划：至少要有一个验收步骤"));
  for (const check of rules(s).checks("missing")) assert.ok(!/可解除阻塞|卡住了，但|标为进行中|正文没写/.test(check.text));
});

test("a title longer than 20 characters, spaces not counted, gets one check", () => {
  const twenty = "一二三四五六七八九十一二三四五六七八九十", twentyOne = twenty + "十";
  const s = snapshot({ exact: { title: twenty }, spaced: { title: "一二 三四五六七八九十一二三四五六七八九十" }, over: { title: twentyOne }, asciiOver: { title: "a".repeat(21) }, record: { title: twentyOne, record: true }, cancelled: { title: twentyOne, status: "cancelled" }, finished: { title: twentyOne, plan: workPlan([step("work", "done")], "done") } });
  assert.equal(rules(s).statusOf("finished"), "done");
  assert.deepEqual(texts(s, "cancelled"), [], "closed items are not checked");
  assert.deepEqual(texts(s, "finished"), [], "closed items are not checked");
  assert.deepEqual(texts(s, "exact"), []);
  assert.deepEqual(texts(s, "spaced"), []);
  assert.deepEqual(texts(s, "over"), ["标题超过 20 个字（现在 21 个）"]);
  assert.deepEqual(texts(s, "asciiOver"), ["标题超过 20 个字（现在 21 个）"]);
  assert.deepEqual(texts(s, "record"), ["标题超过 20 个字（现在 21 个）"], "records have titles too");
});

test("derived arrays are defensive copies and snapshot changes require a new rules object", () => {
  const s = snapshot({ a: { plan: workPlan([own("b"), step("next", "todo", { after: [] })]) }, b: {} }), before = structuredClone(s), r = rules(s);
  r.children("a").push("bad"); r.ancestors("b").push("bad"); r.depsOf("a")[0]!.id = "bad"; r.dependents("b")[0]!.id = "bad";
  const row = r.planRows("a")[0]!; row.row.id = "bad"; row.row.after!.push("bad");
  const group = r.planGroups("a")[0]!; group.start = 99;
  assert.deepEqual(s, before); assert.deepEqual(r.children("a"), ["b"]); assert.equal(r.planRows("a")[0]!.row.id, "b"); assert.equal(r.planGroups("a")[0]!.start, 0);
  const next = structuredClone(s); next.items.b!.plan = workPlan([], "done"); assert.equal(rules(next).planRows("a")[0]!.state, "resolved"); assert.equal(r.planRows("a")[0]!.state, "open");
});

test("plan stamps preserve dates within a state, restamp re-entry, and never put step dates on target rows", () => {
  const previous = step("a", "doing", { since: T0, doneAt: T0 });
  assert.deepEqual(stampPlanRow({ id: "a", text: "Changed", state: "doing" }, previous, T1), { id: "a", text: "Changed", state: "doing", since: T0, doneAt: T0 });
  const done = stampPlanRow({ id: "a", text: "Done", state: "done" }, previous, T1);
  assert.equal("doneAt" in done && done.doneAt, T1);
  const again = stampPlanRow({ id: "a", text: "Again", state: "doing" }, done, T2);
  assert.equal("since" in again && again.since, T2);
  assert.deepEqual(stampPlanRow({ item: "a", own: true, after: [] }, again, T2), own("a"));
  assert.deepEqual(stampPlanRow({ card: "q", after: [] }, undefined, T2), card("q"));
});

test("plan freshness compares own fields and dates by id while reorders and removals remain progress", () => {
  const a = step("a", "doing"), b = shared("b");
  assert.deepEqual(changedItemPlan(undefined, [a, b]), [a, b]); assert.deepEqual(changedItemPlan([a, b], [b, a]), []); assert.equal(planChanged([a, b], [b, a]), true);
  assert.deepEqual(changedItemPlan([a, b], [b]), []); assert.equal(planChanged([a, b], [b]), true); assert.equal(planChanged(undefined, []), false);
  assert.equal(planChanged([a, b], [{ ...a }, { ...b, after: [] }]), false);
  for (const changed of [{ ...a, text: "Changed" }, { ...a, waits: "CI" }, { ...a, since: T1 }, { ...a, after: [] }, { ...a, accept: true as const }]) assert.deepEqual(changedItemPlan([a, b], [changed, b]), [changed]);
  assert.deepEqual(changedItemPlan([a, b], [a, { ...b, own: true }]), [{ ...b, own: true }]);
});

const hour = 60 * 60 * 1000, start = Date.parse(T0);
const timeAt = (hours: number) => new Date(start + hours * hour).toISOString();
function activeBoard(): Snapshot {
  const s = snapshot({ quiet: { plan: workPlan([step("work", "doing")]) }, other: { group: "Second" } });
  s.activity = { writes: Array.from({ length: 7 }, (_, i) => timeAt(i / 2)), items: { quiet: T0, other: timeAt(3) } }; return s;
}
const hasStalled = (s: Snapshot, id = "quiet", hours = 3) => rules(s, start + hours * hour).checks(id).some(c => c.label === STALLED_LABEL);

test("inherited pause suppresses stalled checks but retains form checks", () => {
  const s = activeBoard();
  s.items.root = Item.parse({ title: "Root", group: "Default", updated: T0, rev: 1, plan: workPlan([own("quiet")]) });
  s.items.quiet!.provisional = true;
  assert.equal(hasStalled(s), true);
  s.items.root!.paused = { reason: "Owner stopped this project", at: timeAt(0.25) };
  const r = rules(s, start + 3 * hour);
  assert.equal(r.checks("quiet").some(check => check.label === STALLED_LABEL), false);
  assert.equal(r.stalledBelow("root"), 0);
  assert.equal(r.checks("quiet").some(check => check.text === "计划待重写"), true);
  s.items.quiet!.plan = [step("work", "doing")];
  assert.equal(rules(s, start + 3 * hour).checks("quiet").some(check => check.text === "没有计划：至少要有一个验收步骤"), true);
});

test("resumed inherited work counts active time before and after pause but none during pause", () => {
  const s = activeBoard();
  // The child itself never changed: an ancestor paused it at 15 minutes and
  // resumed it at 150 minutes while other projects kept the board active.
  s.activity!.pauses = { quiet: [{ start: timeAt(0.25), end: timeAt(2.5) }] };
  assert.equal(hasStalled(s, "quiet", 3), false, "only 45 active minutes outside the inherited pause");
  assert.equal(hasStalled(s, "quiet", 3.25 - 1 / hour), false);
  assert.equal(hasStalled(s, "quiet", 3.25), true, "the pre-pause 15 minutes are retained at the one-hour boundary");
  s.activity!.pauses.quiet!.push({ start: timeAt(0.5), end: timeAt(2) });
  assert.equal(hasStalled(s, "quiet", 3.25), true, "overlapping inherited and direct pauses cannot subtract time twice");
  s.activity!.items.quiet = timeAt(2.75);
  assert.equal(hasStalled(s, "quiet", 3.25), false, "ordinary item progress still resets the clock after resuming");
});

test("stalled checks count the union of board-active windows, with an inclusive one-hour threshold", () => {
  const s = activeBoard();
  assert.equal(hasStalled(s), true, "another project wrote throughout three quiet hours");
  assert.equal(hasStalled(s, "quiet", 1 - 1 / hour), false);
  assert.equal(hasStalled(s, "quiet", 1), true);
  delete s.activity;
  assert.equal(hasStalled(s), false, "the board-wide silent interval stops every clock");
  s.activity = { writes: Array.from({ length: 20 }, () => T0), items: {} };
  assert.equal(hasStalled(s), false, "overlapping writes do not multiply active time");
  s.activity.writes.push(timeAt(3));
  assert.equal(hasStalled(s), false, "a write at now does not retroactively fill silence");
  s.activity.writes = [T0, timeAt(1)];
  assert.equal(hasStalled(s, "quiet", 1.5 - 1 / hour), false, "two separated half-hour windows total just under one hour");
  assert.equal(hasStalled(s, "quiet", 1.5), true, "two separated half-hour windows total exactly one hour");
});

test("a doing item's clock counts its own changes and its owned items in progress, including historical card and note revisions", () => {
  const changes: Array<(s: Snapshot) => void> = [
    s => { s.items.quiet!.updated = timeAt(2.5); },
    s => { s.items.quiet!.log.push({ at: timeAt(2.5), text: "Progress" }); },
    s => { s.decisions.card = Decision.parse({ item: "quiet", question: "Decision", options: [{ key: "A", text: "Proceed" }], status: "open", updated: timeAt(2.5), rev: 1 }); },
    s => { s.notes.note = Note.parse({ target: "it:quiet", kind: "comment", text: "Progress", at: timeAt(2.5), state: "sent", rev: 1 }); },
    s => { s.decisions.card = Decision.parse({ item: "quiet", question: "Decision", options: [{ key: "A", text: "Proceed" }], status: "open", updated: T0, rev: 1 }); s.notes.note = Note.parse({ target: "q:card", kind: "comment", text: "Progress", at: T0, repliedAt: timeAt(2.5), state: "done", rev: 1 }); },
    s => { s.activity!.items.quiet = timeAt(2.5); },
  ];
  for (const change of changes) { const s = activeBoard(); assert.equal(hasStalled(s), true); change(s); assert.equal(hasStalled(s), false); }
  const s = activeBoard(); s.items.child = Item.parse({ title: "Child", group: "Default", updated: timeAt(2.5), plan: workPlan(), rev: 1 });
  s.items.quiet!.plan = workPlan([step("work", "doing"), own("child")]); assert.equal(hasStalled(s), true, "a child not in progress does not reset the owner's doing clock");
  s.items.child!.plan = workPlan([step("child-work", "doing")]); assert.equal(hasStalled(s), false, "an owned child in progress resets the owner's doing clock");
  s.items.record = Item.parse({ title: "Queue", group: "Default", record: true, plan: [], updated: timeAt(2.5), rev: 1 });
  s.items.quiet!.plan = workPlan([step("work", "doing"), own("record")]); assert.equal(hasStalled(s), true, "record child progress does not reset the owner's doing clock");
});

test("a doing step's clock reads the items it names and the items they own, but not other rows", () => {
  // A doing step of its own keeps the clock; the second step is the one under test.
  const mentions = (s: Snapshot, text: string, state: PlanStep["state"] = "doing") => { s.items.quiet!.plan = workPlan([step("work", "doing"), step("ref", state, { text })]); return hasStalled(s); };
  // The named item changed within the hour: the step is not quiet.
  let s = activeBoard(); s.items.named = Item.parse({ title: "Named", group: "Default", updated: timeAt(2.5), plan: workPlan(), rev: 1 });
  assert.equal(mentions(s, "see [[it:named]]"), false, "a doing step naming an item that changed recently is not quiet");
  assert.equal(mentions(s, "see [[it:named]]", "todo"), true, "a todo step naming the item does not count");
  assert.equal(mentions(s, "no mention here"), true, "a step without a reference counts only the item itself");
  // Both the item and the named one are quiet for an hour: flagged.
  s = activeBoard(); s.items.named = Item.parse({ title: "Named", group: "Default", updated: T0, plan: workPlan(), rev: 1 });
  assert.equal(mentions(s, "see [[it:named]]"), true, "a named item quiet as well as the item keeps the step quiet");
  // The named item's owned item, two layers down, counts too.
  s = activeBoard(); s.items.named = Item.parse({ title: "Named", group: "Default", plan: workPlan([own("deep")]), updated: T0, rev: 1 });
  s.items.deep = Item.parse({ title: "Deep", group: "Default", updated: timeAt(2.5), plan: workPlan([step("deep-work", "doing")]), rev: 1 });
  assert.equal(mentions(s, "see [[it:named]]"), false, "a change two layers under a named item resets the step's clock");
});

test("a shared item in progress does not reset the owner's clock: that item is someone else's work", () => {
  const s = activeBoard(); s.items.shared = Item.parse({ title: "Shared", group: "Default", updated: timeAt(2.5), plan: workPlan([step("shared-work", "doing")]), rev: 1 });
  s.items.quiet!.plan = workPlan([step("work", "doing"), { id: "shared", item: "shared", own: false }]);
  assert.equal(hasStalled(s), true, "a shared row in progress leaves the owner's clock alone");
});

test("a card reference never continues the clock of an item with the same key", () => {
  const s = activeBoard(); s.items.named = Item.parse({ title: "Named", group: "Default", updated: timeAt(2.5), plan: workPlan(), rev: 1 });
  s.items.quiet!.plan = workPlan([step("work", "doing"), step("ref", "doing", { text: "see [[q:named]]" })]);
  assert.equal(hasStalled(s), true, "[[q:named]] names a decision card, not the item named");
});

test("a reference to a missing, finished or dropped step, or to the item itself, follows the same rule", () => {
  const s = activeBoard();
  s.items.quiet!.plan = workPlan([step("work", "doing"), step("ref", "doing", { text: "see [[it:nowhere]]" })]);
  assert.equal(hasStalled(s), true, "a reference to a missing item is ignored");
  for (const state of ["done", "dropped"] as const) {
    const next = activeBoard(); next.items.named = Item.parse({ title: "Named", group: "Default", updated: timeAt(2.5), plan: workPlan(), rev: 1 });
    next.items.quiet!.plan = workPlan([step("work", "doing"), step("ref", state, { text: "see [[it:named]]" })]);
    assert.equal(hasStalled(next), true, `a ${state} step naming a changed item does not count`);
  }
  const self = activeBoard(); self.items.quiet!.plan = workPlan([step("work", "doing"), step("ref", "doing", { text: "[[it:quiet]]" })]);
  assert.equal(hasStalled(self), true, "a reference to the item itself keeps its own clock");
});

test("a doing step naming an ancestor counts the changes of the ancestor's owned items, not the whole board", () => {
  const s = activeBoard();
  s.items.parent = Item.parse({ title: "Parent", group: "Default", plan: workPlan([own("quiet"), own("sibling")]), updated: T0, rev: 1 });
  s.items.sibling = Item.parse({ title: "Sibling", group: "Default", updated: timeAt(2.5), plan: workPlan(), rev: 1 });
  s.items.quiet!.plan = workPlan([step("work", "doing"), step("ref", "doing", { text: "under [[it:parent]]" })]);
  assert.equal(hasStalled(s), false, "a sibling owned by the named ancestor resets the clock");
  s.items.other = Item.parse({ title: "Other", group: "Default", updated: timeAt(2.5), plan: workPlan(), rev: 1 });
  s.items.quiet!.plan = workPlan([step("work", "doing"), step("ref", "doing", { text: "under [[it:quiet]]" })]);
  assert.equal(hasStalled(s), true, "an unrelated item changed later does not reset the clock");
});

test("references and ownership cycles do not loop and keep a quiet clock quiet", () => {
  const s = activeBoard();
  s.items.cycle1 = Item.parse({ title: "Cycle 1", group: "Default", plan: workPlan([own("cycle2")]), updated: T0, rev: 1 });
  s.items.cycle2 = Item.parse({ title: "Cycle 2", group: "Default", plan: workPlan([own("cycle1")]), updated: T0, rev: 1 });
  s.items.quiet!.plan = workPlan([step("work", "doing"), own("cycle1"), step("ref", "doing", { text: "[[it:cycle2]]" })]);
  assert.equal(hasStalled(s), true, "a cycle of owned items with nothing new is still stalled");
});

test("a doing step's reference to a changed item changes the presentation of its item in the affected walk", () => {
  const board = (): Snapshot => {
    const s = activeBoard();
    s.items.P = Item.parse({ title: "P", group: "Default", plan: workPlan([step("ref", "doing", { text: "see [[it:T]]" })]), updated: T0, rev: 1 });
    s.items.T = Item.parse({ title: "T", group: "Default", plan: workPlan([own("M")]), updated: T0, rev: 1 });
    s.items.M = Item.parse({ title: "M", group: "Default", plan: workPlan([own("X")]), updated: T0, rev: 1 });
    s.items.X = Item.parse({ title: "X", group: "Default", plan: workPlan(), updated: T0, rev: 1 });
    return s;
  };
  const before = board(), after = board(); after.items.X!.updated = timeAt(2.5);
  const now = start + 3 * hour, rb = rules(before, now), ra = rules(after, now);
  assert.notEqual(presentationSignature(rb, before.decisions, "P"), presentationSignature(ra, after.decisions, "P"), "P's stalled check clears when X, two layers under T, changes");
  assert.ok(affectedItems(rb, ra, ["X"]).has("P"), "a change two layers under a named item reaches the item whose step names it");
});

test("an owned item in progress keeps the owner's clock, across every layer below it", () => {
  const s = activeBoard();
  s.items.middle = Item.parse({ title: "Middle", group: "Default", plan: workPlan([own("leaf")]), updated: T0, rev: 1 });
  s.items.leaf = Item.parse({ title: "Leaf", group: "Default", updated: timeAt(2.5), plan: workPlan([step("leaf-work", "doing")]), rev: 1 });
  s.items.quiet!.plan = workPlan([step("work", "doing"), own("middle")]);
  assert.equal(hasStalled(s), false, "a leaf two layers below a progressing owned item resets the owner's clock");
});

test("a parent with only owned progress has no clock, but its own doing step has one", () => {
  const s = activeBoard(); s.items.parent = Item.parse({ title: "Parent", group: "Default", plan: workPlan([own("quiet")]), updated: T0, rev: 1 });
  assert.equal(hasStalled(s, "parent"), false); assert.equal(hasStalled(s), true);
  s.items.parent!.plan = workPlan([own("quiet"), step("own-work", "doing", { after: [] })]); assert.equal(hasStalled(s, "parent"), true);
  const r = rules(s, start + 3 * hour); assert.equal(r.stalledBelow("parent"), 2); assert.equal(checkLabel(r.checks("quiet").find(c => c.label === STALLED_LABEL)!), "无人推进"); assert.equal(checkLabel({}), "需核对");
  for (const fields of [{ record: true, plan: [] }, { plan: workPlan() }, { plan: workPlan([], "done") }, { status: "cancelled" as const }]) { const next = activeBoard(); Object.assign(next.items.quiet!, fields); assert.equal(hasStalled(next), false); }
});

test("current note write times count as active windows across projects", () => {
  const s = activeBoard(); delete s.activity;
  for (let i = 0; i < 6; i++) s.notes["n" + i] = Note.parse({ target: "it:other", kind: "comment", text: "Changed", at: timeAt(i / 2), state: "sent", rev: 1 });
  assert.equal(hasStalled(s), true);
});

test("a todo step that writes its waits as text gets one check per open item, listing its rows by id", () => {
  const s = snapshot({
    two: { plan: workPlan([step("ci", "todo", { waits: "CI" }), step("pr", "todo", { waits: "Owner card" })]) },
    mixed: { plan: workPlan([step("run", "doing", { waits: "CI", since: T0 }), step("review", "todo", { waits: "Review" })]) },
    doneOnly: { plan: workPlan([step("old", "done", { waits: "CI" })]) },
    droppedOnly: { plan: workPlan([step("gone", "dropped", { waits: "CI" })]) },
    doingOnly: { plan: workPlan([step("ci", "doing", { waits: "CI", since: T0 })]) },
    plain: { plan: workPlan([step("write", "todo")]) },
    acceptWaits: { plan: [{ ...accept("todo"), waits: "Owner card" }] },
    cancelled: { status: "cancelled", plan: workPlan([step("ci", "todo", { waits: "CI" })]) },
    record: { record: true, plan: [step("ci", "todo", { waits: "CI" })] },
    paused: { paused: { reason: "Owner deferred", at: T1 }, plan: workPlan([step("ci", "todo", { waits: "CI" })]) },
    owned: { plan: workPlan([step("ci", "todo", { waits: "CI" })]) },
    backlogHolder: { record: true, plan: [own("owned")] },
  });
  const r = rules(s);
  const waitsChecks = (id: string) => r.checks(id).filter(check => check.label === WAITS_TEXT_LABEL);
  const hint = "在等的事写在文字里，看板看不出，所以这些行看着能开工。改法：等别的条目就用共享依赖；等主人就出卡；等 CI、14900K 这类看板外的事，把这一行标成进行中；暂时不做就挪进待选。写了在等的行：";
  assert.deepEqual(waitsChecks("two"), [{ label: WAITS_TEXT_LABEL, text: hint + "ci、pr" }]);
  assert.deepEqual(waitsChecks("mixed"), [{ label: WAITS_TEXT_LABEL, text: hint + "review" }], "only the todo row is listed, not the doing row beside it");
  assert.deepEqual(waitsChecks("doingOnly"), [], "a doing step's waits is a live wait, not a check");
  assert.deepEqual(waitsChecks("doneOnly"), [], "a done step's waits is history");
  assert.deepEqual(waitsChecks("droppedOnly"), [], "a dropped step's waits is history");
  assert.deepEqual(waitsChecks("plain"), [], "a todo step without waits text passes");
  assert.deepEqual(waitsChecks("acceptWaits"), [{ label: WAITS_TEXT_LABEL, text: hint + "accept" }], "an acceptance row waiting in text is listed like any other");
  assert.deepEqual(waitsChecks("cancelled"), [], "cancelled items stay silent");
  assert.deepEqual(waitsChecks("record"), [], "records are not work");
  assert.deepEqual(waitsChecks("paused"), [], "a paused item stays silent until resumed");
  assert.deepEqual(waitsChecks("owned"), [], "work in the backlog stays silent");
});

test("step text and days retain state markers, dates, waits and whole-day boundaries", () => {
  const rows = [step("Done", "done"), step("Doing", "doing", { waits: "CI" }), step("Todo"), step("Dropped", "dropped")], s = snapshot({ a: {} }), r = rules(s, Date.parse(T2));
  assert.deepEqual(rows.map(r.stepLine), ["✓ Done (10-10)", "● Doing — 2 天，等 CI", "○ Todo", "✗ Dropped — Replaced"]);
  assert.equal(rules(s, Date.parse(T1) - 1).stepDays(rows[1]!), 0); assert.equal(rules(s, Date.parse(T1)).stepDays(rows[1]!), 1); assert.equal(rules(s, Date.parse(T0) - 1).stepDays(rows[1]!), 0);
});

test("targets retain required text, exact prose, server dates and unique goal ids", () => {
  const input = { id: "style", goal: "  apollo11 style time  ", target: "  ≤ 1 倍 Chromium  ", current: "  12 倍 Chromium  ", baseline: "  Chromium 同机同页  " }, stored = { ...input, date: T0 };
  assert.deepEqual(ItemTargetInput.parse(input), input); assert.equal(ItemTarget.safeParse(input).success, false); assert.deepEqual(ItemTarget.parse(stored), stored); assert.equal(ItemTargetInput.safeParse(stored).success, false);
  for (const field of ["goal", "target", "current", "baseline"] as const) for (const value of [undefined, "", " \n "]) assert.equal(ItemTargetInput.safeParse({ ...input, [field]: value }).success, false);
  assert.equal(Item.safeParse({ title: "Bad", group: "Default", plan: workPlan(), updated: T0, rev: 1, targets: [stored, stored] }).success, false);
  assert.equal(Object.hasOwn(snapshot({ a: {} }).items.a!, "targets"), false);
  assert.equal(stampItemTarget(input, undefined, T0).date, T0); assert.equal(stampItemTarget({ ...input, goal: "New" }, stored, T1).date, T0); assert.equal(stampItemTarget({ ...input, current: "New" }, stored, T1).date, T1);
});

test("target text is compact and does not affect status, and freshness uses full values by goal id", () => {
  const a = { id: "a", goal: "A", target: "1× main", current: "2× main", baseline: "main", date: T0 }, b = { ...a, id: "b", goal: "B" };
  assert.equal(targetLine(a), "A: 2× main (vs main) → 1× main, 2026-10-10"); assert.equal(targetLine({ ...a, goal: "  A\n " }), targetLine(a));
  const r = rules(snapshot({ work: { targets: [a] }, record: { record: true, targets: [a] } })); assert.equal(r.statusOf("work"), "todo"); assert.equal(r.statusOf("record"), undefined);
  assert.deepEqual(changedItemTargets(undefined, [a, b]), [a, b]); assert.deepEqual(changedItemTargets([a, b], [b, a]), []); assert.equal(targetsChanged([a, b], [b, a]), true);
  assert.deepEqual(changedItemTargets([a, b], [b]), []); assert.equal(targetsChanged([a, b], [b]), true); assert.equal(targetsChanged(undefined, []), false);
  assert.equal(targetsChanged([a, b], [{ ...a }, { ...b }]), false);
  for (const changed of [{ ...a, goal: "New" }, { ...a, target: "New" }, { ...a, current: "New" }, { ...a, baseline: "New" }, { ...a, date: T1 }, { ...a, id: "new" }]) { assert.deepEqual(changedItemTargets([a, b], [changed, b]), [changed]); assert.equal(targetsChanged([a, b], [changed, b]), true); }
});

test("log entries and dispatch records never count as owner-unread: one rule drops them and names log-only change summaries", () => {
  assert.deepEqual(withoutHistoricalDetail({ title: "T", log: [{ at: T0, text: "x" }] }), { title: "T" });
  assert.deepEqual(withoutHistoricalDetail({ title: "T", dispatches: [{ agentId: "a" }], log: [] }), { title: "T" });
  assert.deepEqual(["+2 log", "log changed"].map(isLogChange), [true, true]);
  assert.deepEqual(["steps changed", "head changed", "+2 logs here"].map(isLogChange), [false, false, false]);
});


test("nested shared diamonds evaluate each acyclic target once per snapshot", () => {
  const items: Record<string, Partial<Item>> = { leaf: { plan: workPlan([], "done") } };
  for (let level = 0; level < 10; level++) for (const side of ["a", "b"]) {
    const targets = level ? [`a${level - 1}`, `b${level - 1}`] : ["leaf"];
    items[`${side}${level}`] = { plan: workPlan(targets.map(id => shared(id)), "done") };
  }
  const s = snapshot(items), leaf = s.items.leaf!.plan[0]!;
  assert.ok("state" in leaf);
  let reads = 0;
  Object.defineProperty(leaf, "state", { get() { reads++; return "done"; }, configurable: true });
  const r = rules(s);
  assert.equal(r.statusOf("a9"), "done");
  assert.equal(r.statusOf("b9"), "done");
  assert.equal(r.planRows("a9")[0]!.state, "resolved");
  assert.ok(reads <= 4, `the shared leaf must not be re-walked along each path: ${reads} state reads`);
  Object.defineProperty(leaf, "state", { value: "todo", writable: true, configurable: true });
  assert.equal(rules(s).statusOf("a9"), "blocked", "a new snapshot recomputes target state");
});

test("status target memoization never caches a cycle fallback as a target result", () => {
  const s = snapshot({
    a: { plan: workPlan([own("b"), step("working", "doing")]) },
    b: { plan: workPlan([own("a")]) },
    outside: { plan: workPlan([own("b")]) },
  });
  for (const first of ["a", "b", "outside"]) {
    const r = rules(s);
    assert.equal(r.statusOf(first), "wip");
    for (const id of ["a", "b", "outside"]) assert.equal(r.statusOf(id), "wip", `${first} must not poison ${id}`);
  }
});

test("a line holding only [[q:key]] places that card; a token in a sentence, a fenced line and a repeat place nothing more", () => {
  assert.equal(cardMarker("[[q:first]]"), "first");
  assert.equal(cardMarker("  [[q:first]]  "), "first");
  assert.equal(cardMarker("see [[q:first]]"), undefined);
  assert.equal(cardMarker("[[it:first]]"), undefined);
  assert.equal(cardMarker("- [[q:first]]"), undefined);
  assert.deepEqual(placedCards("Why.\n\n[[q:b]]\n\nThen [[q:no]] here\n```\n[[q:fenced]]\n```\n[[q:a]]\n[[q:b]]\r\n"), ["b", "a"]);
  assert.deepEqual(placedCards(undefined), []);
});

test("an open card its item's head does not place gets one check; a closed card, or a placed one, none", () => {
  const plan = workPlan([card("open"), card("done")]);
  const s = snapshot({ a: { plan } }, { open: { item: "a" }, done: { item: "a", status: "ruled" } });
  assert.deepEqual(rules(s).checks("a").filter(c => c.label === CARD_UNPLACED_LABEL).map(c => c.target), [{ kind: "card", id: "open" }]);
  assert.match(texts(s, "a").join("\n"), /\[\[q:open\]\]/);
  s.items.a = Item.parse({ ...s.items.a!, head: "The question comes here.\n\n[[q:open]]" });
  assert.deepEqual(rules(s).checks("a").filter(c => c.label === CARD_UNPLACED_LABEL), []);
  s.items.a = Item.parse({ ...s.items.a!, head: "Inside a sentence [[q:open]] is only a link." });
  assert.equal(rules(s).checks("a").filter(c => c.label === CARD_UNPLACED_LABEL).length, 1);
  s.decisions.open = Decision.parse({ ...s.decisions.open!, status: "withdrawn" });
  assert.equal(rules(s).checks("a").filter(c => c.label === CARD_UNPLACED_LABEL).length, 0);
});

test("a card and its row that disagree get a check on the item: a blocking card without a row, a non-blocking open card with one, or a row for another item's card", () => {
  const s = snapshot({ a: { plan: workPlan([card("foreign"), card("loose")]) }, b: {} }, {
    foreign: { item: "b", status: "ruled" }, rowless: { item: "a", status: "open", blocks: "The work stops" }, closed: { item: "a", status: "ruled" },
    loose: { item: "a", status: "open" },
  });
  const mismatches = (id: string) => rules(s).checks(id).filter(c => c.label === CARD_MISMATCH_LABEL).map(c => c.text);
  // A closed card with no row is fine: only a card that blocks has a row.
  assert.deepEqual(mismatches("a"), ["卡和计划对不上：rowless 挡事，却没有计划行；loose 不挡事，却有计划行；foreign 属于条目 b"]);
  assert.deepEqual(mismatches("b"), []);
  s.items.a = Item.parse({ ...s.items.a!, plan: workPlan([card("rowless")]) });
  assert.deepEqual([mismatches("a"), mismatches("b")], [[], []]);
});

test("the presentation of an item changes when a card row's pick changes", () => {
  const s = snapshot({ a: { plan: workPlan([card("q")]) } }, { q: { item: "a", options: [{ key: "A", text: "First" }, { key: "B", text: "Second" }] } });
  const open = presentationSignature(rules(s), s.decisions, "a");
  s.decisions.q = Decision.parse({ ...s.decisions.q!, status: "ruled", choice: "A" });
  const first = presentationSignature(rules(s), s.decisions, "a");
  s.decisions.q = Decision.parse({ ...s.decisions.q!, choice: "B" });
  const second = presentationSignature(rules(s), s.decisions, "a");
  assert.equal(new Set([open, first, second]).size, 3);
});

test("the page's presentation signature changes with an item's difficulty, so a reloaded board repaints it", () => {
  const sign = (fields: Partial<Item>) => { const s = snapshot({ a: fields }); return presentationSignature(rules(s), s.decisions, "a"); };
  const signs = ([2, 3, 5, undefined] as const).map(difficulty => sign({ difficulty }));
  assert.equal(new Set(signs).size, 4, "each difficulty, and none, paints differently");
  assert.equal(sign({ difficulty: 2 }), sign({ difficulty: 2 }), "an unchanged one does not");
});

test("open decision cards with fewer than three options get a check on the card and on their item", () => {
  const options = [{ key: "A", text: "Do" }, { key: "B", text: "Skip" }];
  const s = snapshot({ owner: {} }, {
    two: { item: "owner", options },
    three: { item: "owner", options: [...options, { key: "C", text: "Later" }] },
    ruled: { item: "owner", options, status: "ruled", choice: "A" },
  });
  const r = rules(s), [card] = r.cardChecks("two");
  assert.deepEqual(r.cardChecks("three"), [], "three options are enough");
  assert.deepEqual(r.cardChecks("ruled"), [], "a ruled card is not checked");
  assert.equal(card?.label, "选项不足");
  assert.deepEqual(r.checks("owner").filter(c => c.label === "选项不足"), [{ ...card, target: { kind: "card", id: "two" } }]);
});

test("the option check covers one-option cards and stops once the owner has chosen", () => {
  const options = [{ key: "A", text: "Do" }, { key: "B", text: "Skip" }];
  const s = snapshot({ owner: {} }, {
    one: { item: "owner", options: [{ key: "A", text: "Do" }] },
    // Sending the owner's pick rules the card in the same commit, so an answered card is ruled, not open.
    chosen: { item: "owner", options, status: "ruled", choice: "A" },
  });
  assert.equal(rules(s).cardChecks("one")[0]?.label, "选项不足", "a one-option card is checked");
  assert.deepEqual(rules(s).cardChecks("chosen"), [], "a card the owner has answered is not checked");
});
