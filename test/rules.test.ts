import assert from "node:assert/strict";
import test from "node:test";
import { Decision, Item, ItemStep, ItemStepInput, Note } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { rules, changedItemSteps, stepsChanged, checkLabel, STALLED_LABEL, withoutLog, isLogChange } from "../src/rules.ts";

const T0 = "2026-10-10T00:00:00Z", T1 = "2026-10-11T00:00:00Z", T2 = "2026-10-12T00:00:00Z";
// Items state a completion condition unless a case is about a head without one.
const DONE_WHEN = "**完成条件**：测试通过";
function snapshot(items: Record<string, Partial<Item>>, decisions: Record<string, Partial<Decision>> = {}, notes: Record<string, Partial<Note>> = {}, archived: Record<string, string> = {}): Snapshot {
  return {
    board: { title: "Synthetic", projects: ["Default","First","Second"].map(name => ({name, migrated: true})) }, head: "0".repeat(40), notices: {},
    items: Object.fromEntries(Object.entries(items).map(([id, fields]) => [id, Item.parse({ title: id, group: "Default", head: DONE_WHEN, updated: T0, rev: 1, ...fields })])),
    decisions: Object.fromEntries(Object.entries(decisions).map(([id, fields]) => [id, Decision.parse({ item: "area", question: id, background: "why", options: [{ key: "A", text: "choose" }], status: "open", updated: T0, rev: 1, ...fields })])),
    notes: Object.fromEntries(Object.entries(notes).map(([id, fields]) => [id, Note.parse({ target: "it:area", kind: "comment", text: "note", at: T0, state: "sent", rev: 1, ...fields })])),
    glossaries: {}, owner: { archived },
  };
}
// The same board with the named projects migrated and the rest as board.yaml without the field.
function projects(s: Snapshot, migrated: string[]): Snapshot {
  return { ...s, board: { ...s.board, projects: s.board.projects.map(({ name }) => migrated.includes(name) ? { name, migrated: true } : { name }) } };
}
const legacy = (...a: Parameters<typeof snapshot>): Snapshot => projects(snapshot(...a), []);
const dep = (id: string, why = "needs it") => ({ id, why });
const card = (key: string, why = "needs ruling") => ({ card: key, why });

test("tree lookup, unsorted children, grouped areas, inheritance and missing ids", () => {
  const s = snapshot({
    a: { group: "First", order: 9 }, z: { group: "Second", order: -4 }, a2: { group: "First", order: 1 },
    c2: { parent: "a", order: 2 }, c1: { parent: "a", order: 1 },
    leaf: { parent: "c1" }, orphan: { parent: "absent" },
  });
  const r = rules(s);
  assert.equal(r.item("a"), s.items.a);
  assert.equal(r.item("absent"), undefined);
  assert.equal(r.item("constructor"), undefined);
  assert.equal(r.parentOf("a"), undefined);
  assert.equal(r.parentOf("orphan"), undefined);
  assert.equal(r.parentOf("leaf"), "c1");
  assert.deepEqual(r.children("a"), ["c2", "c1"]);
  assert.deepEqual(r.children("absent"), ["orphan"]);
  assert.deepEqual(r.areas(), ["z", "a2", "a"]);
  assert.deepEqual(r.ancestors("leaf"), ["c1", "a"]);
  assert.deepEqual(r.ancestors("orphan"), []);
  assert.equal(r.lineOf("leaf"), "a");
  assert.equal(r.lineOf("a"), "a");
  assert.equal(r.groupOf("leaf"), "First");
  assert.equal(r.projectOf("c2"), "First");
  assert.equal(r.projectOf("leaf"), "First");
  assert.equal(r.projectOf("orphan"), "Default");
  assert.equal(r.isLeaf("a"), false);
  assert.equal(r.isLeaf("leaf"), true);
  assert.equal(r.lineOf("absent"), "absent");
  assert.equal(r.groupOf("absent"), "");
  assert.equal(r.projectOf("absent"), "");
  assert.equal(r.isLeaf("absent"), false); // dangling children remain indexed
  assert.equal(r.statusOf("unknown"), "todo");
  assert.equal(r.priorityOf("unknown"), "");
  assert.equal(r.isRoot("unknown"), false);
  assert.deepEqual(r.depsOf("unknown"), []);
  assert.deepEqual(r.cardsOf("unknown"), []);
  assert.deepEqual(r.checks("unknown"), []);
});

test("status rolls up children, ignoring a parent's written status", () => {
  const cases: Array<[Array<Item["status"]>, string]> = [
    [["cancelled", "cancelled"], "cancelled"], [["done", "cancelled"], "done"],
    [["done", "todo"], "todo"], [["blocked", "todo"], "blocked"], [["blocked", "wip"], "wip"],
    [[undefined], "todo"],
  ];
  for (const [statuses, expected] of cases) {
    const items: Record<string, Partial<Item>> = { area: { status: "done" } };
    statuses.forEach((status, i) => { items["c" + i] = { parent: "area", status }; });
    assert.equal(rules(snapshot(items)).statusOf("area"), expected);
  }
  for (const status of ["todo", "wip", "blocked", "done", "cancelled"] as const) assert.equal(rules(snapshot({ leaf: { status } })).statusOf("leaf"), status);
});

test("dependencies retain missing targets, distinguish cards and deduplicate reverse waiters", () => {
  const r = rules(snapshot({
    a: { deps: [dep("b", "first"), dep("b", "second"), dep("missing"), card("open"), card("ruled"), card("absent"), dep("cancelled")] },
    b: { status: "done" }, cancelled: { status: "cancelled" }, c: { deps: [dep("b", "other"), card("open")] },
  }, { open: { item: "a" }, ruled: { item: "a", status: "ruled" } }));
  assert.deepEqual(r.depsOf("a"), [
    { kind: "item", id: "b", why: "first", missing: false, open: false },
    { kind: "item", id: "b", why: "second", missing: false, open: false },
    { kind: "item", id: "missing", why: "needs it", missing: true, open: false },
    { kind: "card", id: "open", why: "needs ruling", missing: false, open: true },
    { kind: "card", id: "ruled", why: "needs ruling", missing: false, open: false },
    { kind: "card", id: "absent", why: "needs ruling", missing: true, open: false },
    { kind: "item", id: "cancelled", why: "needs it", missing: false, open: false },
  ]);
  assert.deepEqual(r.dependents("b"), [{ id: "a", why: "first" }, { id: "c", why: "other" }]);
  assert.deepEqual(r.dependents("missing"), [{ id: "a", why: "needs it" }]);
  assert.deepEqual(r.cardDependents("open"), [{ id: "a", why: "needs ruling" }, { id: "c", why: "needs ruling" }]);
  assert.deepEqual(r.cardDependents("absent"), [{ id: "a", why: "needs ruling" }]);
  assert.deepEqual(r.dependents("open"), []);
  assert.deepEqual(r.cardDependents("b"), []);
});

test("cards belong to decision.item and sort by order, regardless of status", () => {
  const r = rules(snapshot({ a: {}, b: {} }, {
    later: { item: "a", order: 2 }, ruled: { item: "a", order: -1, status: "ruled" },
    withtree: { item: "a", status: "withtree" }, elsewhere: { item: "b", status: "elsewhere" },
  }));
  assert.deepEqual(r.cardsOf("a"), ["ruled", "withtree", "later"]);
  assert.deepEqual(r.cardsOf("b"), ["elsewhere"]);
  assert.equal(r.needsOwner("a"), true);
  assert.equal(r.needsOwner("b"), false);
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

test("open cards wait for a sent/done choice; comments and drafts do not answer", () => {
  for (const status of ["open", "ruled", "withtree", "elsewhere"] as const) for (const state of ["draft", "sent", "done"] as const) {
    const r = rules(snapshot({ a: {} }, { q: { item: "a", status } }, { n: { target: "q:q", kind: "choice", state } }));
    assert.equal(r.needsOwner("a"), status === "open" && state === "draft", `${status}/${state}`);
  }
  const r = rules(snapshot({ a: { ask: { text: "merge" } } }, { q: { item: "a" } }, { n: { target: "q:q", kind: "comment" } }));
  assert.equal(r.needsOwner("a"), true);
  const answered = rules(snapshot({ a: { ask: { text: "merge" } } }, { q: { item: "a" } }, { n: { target: "it:a", kind: "approve", text: "同意：merge" } }));
  assert.equal(answered.needsOwner("a"), true); // answered ask does not answer card
});

test("cycles cover deps, parent edges and mixed edges without marking their waiters", () => {
  const r = rules(snapshot({
    a: { priority: "P2", deps: [dep("b")] }, b: { priority: "P1", deps: [dep("a")] },
    waiter: { priority: "P0", deps: [dep("a")] }, self: { deps: [dep("self")] },
    p: {}, c: { parent: "p", deps: [dep("p")] }, x: { parent: "y" }, y: { parent: "x" },
    clear: { deps: [dep("missing"), card("q")] },
  }, { q: { item: "clear" } }));
  for (const id of ["a", "b", "self", "p", "c", "x", "y"]) assert.equal(r.onCycle(id), true, id);
  for (const id of ["waiter", "clear", "missing"]) assert.equal(r.onCycle(id), false, id);
  assert.equal(r.priorityOf("a"), "P0");
  assert.equal(r.priorityOf("b"), "P0");
  assert.deepEqual(r.ancestors("x"), ["y"]);
  assert.equal(r.statusOf("x"), "todo");
  assert.equal(r.priorityOf("x"), "");
  assert.equal(r.inArchive("x"), false);
});

test("archives use the latest update, any log and replied notes with legacy time fallbacks", () => {
  const items: Record<string, Partial<Item>> = {
    equal: { updated: T1 }, update: { updated: T2 }, log: { log: [{ at: T2, text: "new" }, { at: T0, text: "old" }] },
    reply: {}, sentFallback: {}, atFallback: {}, noReply: {}, cardReply: {}, area: {}, child: { parent: "area", updated: T2 },
  };
  const r = rules(snapshot(items, { q: { item: "cardReply", updated: T2 } }, {
    r: { target: "it:reply", reply: "answer", repliedAt: T2 }, s: { target: "it:sentFallback", reply: "answer", sentAt: T2 },
    a: { target: "it:atFallback", reply: "answer", at: T2 }, n: { target: "it:noReply", at: T2, repliedAt: T2 },
    c: { target: "q:q", reply: "answer", repliedAt: T2 },
  }, Object.fromEntries(Object.keys(items).filter(id => id !== "child").map(id => [id, T1]))));
  for (const id of ["update", "log", "reply", "sentFallback", "atFallback"]) assert.equal(r.isArchived(id), false, id);
  for (const id of ["equal", "noReply", "cardReply", "area"]) assert.equal(r.isArchived(id), true, id);
  assert.equal(r.isArchived("child"), false);
  assert.equal(r.inArchive("child"), true);
  assert.equal(r.isArchived("missing"), false);
  assert.equal(r.inArchive("missing"), false);
  assert.deepEqual(r.checks("child"), []);
});

const C = {
  missing: "依赖的条目不存在：missing", missingCard: "依赖的决策卡不存在：absent", cancelled: "依赖的条目已取消",
  why: "依赖没写为什么：", cycle: "依赖成环", project: "项目没有配置：", parent: "上级条目不存在：missing",
  unlisted: "上级没有把它列在依赖里（上级必须是直接依赖它的条目）：", unblock: "可解除阻塞：等的都已完成",
  blocker: "卡住了，但没写在等什么", wip: "标为进行中，但还在等别的",
};
test("legacy checks apart from superseded per-item ownership have the exact text, condition, suppression and target", () => {
  const cases: Array<[Partial<Item>, Record<string, Partial<Item>>, Array<{ text: string; target?: { kind: "item"; id: string } }>]> = [
    [{ deps: [dep("missing")] }, {}, [{ text: C.missing }]],
    [{ deps: [dep("cancelled", "")] }, { cancelled: { status: "cancelled" } }, [{ text: C.cancelled, target: { kind: "item", id: "cancelled" } }]],
    [{ status: "cancelled", deps: [dep("cancelled")] }, { cancelled: { status: "cancelled" } }, []],
    [{ deps: [dep("own"), dep("live")] }, { own: { parent: "a", status: "cancelled" }, live: { parent: "a" } }, []], // a parent keeps listing its cancelled sub-item
    [{ status: "done", deps: [dep("cancelled")] }, { cancelled: { status: "cancelled" } }, []],
    [{ deps: [dep("other", "")] }, { other: {} }, [{ text: C.why, target: { kind: "item", id: "other" } }]],
    [{ status: "done", deps: [dep("other", "")] }, { other: {} }, []],
    [{ status: "cancelled", deps: [dep("other", "")] }, { other: {} }, []],
    [{ deps: [dep("a")] }, {}, [{ text: C.cycle }]],
    [{ group: undefined }, {}, [{ text: C.project }]],
    [{ parent: "missing" }, {}, [{ text: C.parent }]],
    [{ parent: "p" }, { p: {} }, [{ text: C.unlisted, target: { kind: "item", id: "p" } }]],
    [{ parent: "p", status: "done" }, { p: {} }, []],
    [{ parent: "p" }, { p: { deps: [dep("a")] } }, []],
    [{ status: "blocked", deps: [dep("done")] }, { done: { status: "done" } }, [{ text: C.unblock }]],
    [{ status: "blocked", deps: [dep("missing")] }, {}, [{ text: C.missing }, { text: C.unblock }]],
    [{ status: "blocked" }, {}, [{ text: C.blocker }]],
    [{ status: "blocked", ask: { text: "approve" } }, {}, []],
    [{ status: "blocked", deps: [dep("other")] }, { other: {} }, []],
    [{ status: "wip", deps: [dep("other")] }, { other: {} }, [{ text: C.wip, target: { kind: "item", id: "other" } }]],
    [{ status: "wip", deps: [dep("done")] }, { done: { status: "done" } }, []],
    [{ status: "blocked" }, { child: { parent: "a" } }, []], // parent status is derived; leaf checks do not apply
  ];
  for (const [a, others, expected] of cases) assert.deepEqual(rules(snapshot({ a: { priority: "P2", ...a }, ...others })).checks("a"), expected, JSON.stringify(a));
  assert.deepEqual(rules(snapshot({ a: { status: "blocked", deps: [dep("missing")] } }, {}, {}, { a: T1 })).checks("a"), []);
});

test("card deps participate in missing/why/wip/blocker checks but not item cycles or priority raising", () => {
  const r = rules(snapshot({
    a: { status: "blocked", priority: "P2", deps: [card("q")] }, b: { status: "blocked", priority: "P2", deps: [card("closed")] },
    c: { status: "blocked", priority: "P2", deps: [card("absent")] }, d: { status: "wip", priority: "P2", deps: [card("q", "")] },
    urgent: { priority: "P0", deps: [card("q")] }, host: { priority: "P2" },
  }, { q: { item: "host" }, closed: { item: "host", status: "ruled" } }, { choice: { target: "q:q", kind: "choice" } }));
  assert.deepEqual(r.checks("a"), []); // sent choice does not close an open dependency
  assert.deepEqual(r.checks("b"), [{ text: C.unblock }]);
  assert.deepEqual(r.checks("c"), [{ text: C.missingCard }, { text: C.unblock }]);
  assert.deepEqual(r.checks("d"), [{ text: C.why, target: { kind: "card", id: "q" } }, { text: C.wip, target: { kind: "card", id: "q" } }]);
  assert.equal(r.onCycle("host"), false);
  assert.equal(r.priorityOf("host"), "P2");
  const ownCard = rules(snapshot({ a: { status: "blocked", priority: "P2" } }, { q: { item: "a" } }));
  assert.deepEqual(ownCard.checks("a"), []);
  const answeredCard = rules(snapshot({ a: { status: "blocked", priority: "P2" } }, { q: { item: "a" } }, { n: { target: "q:q", kind: "choice" } }));
  assert.deepEqual(answeredCard.checks("a"), [{ text: C.blocker }]);
});

test("sibling sorting uses priority, then open/ended, then order", () => {
  const r = rules(snapshot({
    low: { priority: "P2", order: -10 }, urgent: { priority: "P0", deps: [dep("low")] },
    p1: { priority: "P1" }, done0: { priority: "P0", status: "done" }, drop0: { priority: "P0", status: "cancelled", order: 2 },
    openLate: { priority: "P1", order: 3 }, unset: { order: -99 },
  }));
  assert.deepEqual(["unset", "openLate", "p1", "drop0", "done0", "low"].sort(r.compareSiblings), ["low", "done0", "drop0", "p1", "openLate", "unset"]);
  assert.equal(r.compareSiblings("p1", "p1"), 0);
  assert.equal(r.compareSiblings("p1", "openLate"), -3);
});

test("cached result arrays are isolated and rules never mutate the snapshot", () => {
  const s = snapshot({ a: { priority: "P2", deps: [dep("b", "")] }, b: { parent: "a" } }, { q: { item: "b" } });
  const before = structuredClone(s), r = rules(s);
  r.children("a").push("bad"); r.ancestors("b").push("bad"); r.areas().push("bad"); r.cardsOf("b").push("bad");
  r.depsOf("a")[0]!.why = "bad"; r.dependents("b")[0]!.why = "bad";
  const checks = r.checks("a"); checks[0]!.text = "bad"; checks[0]!.target!.id = "bad";
  assert.deepEqual(r.children("a"), ["b"]);
  assert.deepEqual(r.ancestors("b"), ["a"]);
  assert.deepEqual(r.areas(), ["a"]);
  assert.deepEqual(r.cardsOf("b"), ["q"]);
  assert.equal(r.depsOf("a")[0]!.why, "");
  assert.equal(r.dependents("b")[0]!.why, "");
  assert.deepEqual(r.checks("a"), [{ text: C.why, target: { kind: "item", id: "b" } }]);
  r.statusOf("a"); r.priorityOf("a"); r.onCycle("a"); r.needsOwner("b");
  assert.deepEqual(s, before);
  const next = { ...s, items: { ...s.items, b: { ...s.items.b!, status: "done" as const, priority: "P0" as const } } };
  assert.equal(rules(next).statusOf("a"), "done");
  assert.equal(r.statusOf("a"), "todo");
});

test("project rules resolve identity, flag configuration and separate ordered inboxes", () => {
  const s: Snapshot = { board: { title: "Projects", projects: [{ name: "P" }, { name: "Empty" }] }, head: "", owner: { archived: {} }, notes: {}, decisions: {}, glossaries: {}, notices: {}, items: {} };
  for (const [id, fields] of Object.entries({ area: { group: "P" }, child: { parent: "area" }, empty: { group: "Empty" }, missing: { group: "Missing" }, newer: { group: "P", request: { by: "x", at: T2 } }, older: { group: "P", request: { by: "x", at: T1 } }, closed: { group: "P", request: { by: "x", at: T0 }, status: "cancelled" } })) s.items[id] = Item.parse({ title: id, head: DONE_WHEN, priority: "P2", updated: T0, rev: 1, ...fields });
  const r = rules(s);
  assert.equal(r.projectOf("child"), "P");
  assert.equal(Object.hasOwn(r, "agentsFor"), false);
  assert.deepEqual(r.checks("empty"), []);
  assert.deepEqual(r.checks("missing").map(c => c.text), ["项目没有配置：Missing"]);
  assert.deepEqual(r.inbox("P"), ["older", "newer"]); assert.equal(r.isRequest("closed"), false);
  assert.ok(!r.areas().includes("older")); assert.ok(!r.areas().includes("newer"));
});

test("priority flows from a root through several levels of parent listings and dependencies, ignoring stored priority below the root", () => {
  // Insert dependencies before their dependents so one pass in key order is not enough.
  const r = rules(snapshot({
    far: { priority: "P2" }, leaf: { parent: "mid", priority: "P2", deps: [dep("far")] }, mid: { parent: "area", deps: [dep("leaf")] },
    area: { priority: "P0", deps: [dep("mid")] }, loose: { priority: "P1" },
  }));
  assert.equal(r.isRoot("area"), true); assert.equal(r.isRoot("loose"), true);
  for (const id of ["mid", "leaf", "far"]) { assert.equal(r.isRoot(id), false, id); assert.equal(r.priorityOf(id), "P0", id); }
  assert.equal(r.priorityOf("area"), "P0"); assert.equal(r.priorityOf("loose"), "P1");
});

test("a child is raised above its parent by another dependent but never falls below its parent", () => {
  const r = rules(snapshot({
    area: { priority: "P2", deps: [dep("parent")] }, parent: { parent: "area", deps: [dep("child")] }, child: { parent: "parent" },
    urgent: { priority: "P0", deps: [dep("child")] }, later: { priority: "P2", deps: [dep("parent")] },
  }));
  assert.equal(r.priorityOf("parent"), "P2"); assert.equal(r.priorityOf("child"), "P0");
  const lower = rules(snapshot({ area: { priority: "P0", deps: [dep("child")] }, child: { parent: "area" }, other: { priority: "P2", deps: [dep("child")] } }));
  assert.equal(lower.priorityOf("child"), "P0");
});

test("priority crosses projects through dependencies", () => {
  const r = rules(snapshot({
    goal: { group: "First", priority: "P0", deps: [dep("step")] }, step: { parent: "goal", priority: "P2", deps: [dep("theirs")] },
    theirs: { group: "Second", priority: "P2", deps: [dep("part")] }, part: { parent: "theirs", priority: "P2" },
    own: { group: "Second", priority: "P2" },
  }));
  for (const id of ["step", "theirs", "part"]) assert.equal(r.priorityOf(id), "P0", id);
  assert.equal(r.priorityOf("own"), "P2");
});

test("closed dependents raise nothing, closed roots keep their own priority, and an item left without an open dependent is a root", () => {
  const r = rules(snapshot({
    shipped: { status: "done", priority: "P0", deps: [dep("shared")] }, dropped: { status: "cancelled", priority: "P0", deps: [dep("shared")] },
    open: { priority: "P2", deps: [dep("shared")] }, shared: {},
    live: { priority: "P1", deps: [dep("finished")] }, finished: { status: "done", deps: [dep("beyond")] }, beyond: {},
    orphaned: { status: "done", priority: "P1", deps: [dep("stranded")] }, stranded: { priority: "P0" },
  }));
  assert.equal(r.priorityOf("shared"), "P2");
  assert.equal(r.priorityOf("shipped"), "P0"); assert.equal(r.priorityOf("dropped"), "P0");
  assert.equal(r.priorityOf("finished"), "P1"); // a closed item keeps what reached it but passes nothing on
  assert.equal(r.priorityOf("beyond"), "");
  assert.equal(r.isRoot("stranded"), true); assert.equal(r.priorityOf("stranded"), "P0"); // its only dependent is done
  assert.equal(r.isRoot("shared"), false); assert.equal(r.isRoot("beyond"), true); // finished, its only dependent, is done
});

test("a dependency cycle terminates: alone it has no priority, and an open outside dependent reaches all of it", () => {
  const alone = rules(snapshot({ a: { priority: "P0", deps: [dep("b")] }, b: { priority: "P1", deps: [dep("a")] } }));
  for (const id of ["a", "b"]) { assert.equal(alone.isRoot(id), false); assert.equal(alone.priorityOf(id), ""); assert.equal(alone.onCycle(id), true); }
  const reached = rules(snapshot({ a: { priority: "P0", deps: [dep("b")] }, b: { priority: "P2", deps: [dep("c")] }, c: { deps: [dep("a")] }, waiter: { priority: "P1", deps: [dep("b")] } }));
  for (const id of ["a", "b", "c"]) assert.equal(reached.priorityOf(id), "P1", id);
});

test("a dependency on a decision card carries no priority and does not make the card's item a non-root", () => {
  const r = rules(snapshot({ urgent: { priority: "P0", deps: [card("q")] }, host: { priority: "P2" }, bare: {} }, { q: { item: "host" }, other: { item: "bare" } }));
  assert.equal(r.isRoot("host"), true); assert.equal(r.priorityOf("host"), "P2");
  const unset = rules(snapshot({ urgent: { priority: "P0", deps: [card("q")] }, host: {} }, { q: { item: "host" } }));
  assert.equal(unset.priorityOf("host"), "");
});

const NO_DONE_WHEN = "正文没写完成条件", NO_PRIORITY = "没有未完成的条目依赖它，却没写优先级";
test("open items without a completion-condition heading or bold label are flagged", () => {
  for (const head of ["**完成条件**：测试通过", "背景\n\n**怎样算完成**：页面显示", "## 完成条件\n\n测试通过", "**完成条件和验证**"]) {
    assert.deepEqual(rules(snapshot({ a: { priority: "P2", head } })).checks("a"), [], head);
  }
  for (const head of [undefined, "", "完成条件：没有标题或加粗", "**背景**：写了别的"]) {
    assert.deepEqual(rules(snapshot({ a: { priority: "P2", head } })).checks("a"), [{ text: NO_DONE_WHEN }], String(head));
  }
  for (const status of ["done", "cancelled"] as const) assert.deepEqual(rules(snapshot({ a: { priority: "P2", status, head: "" } })).checks("a"), [], status);
  const parent = rules(snapshot({ a: { priority: "P2", head: "", deps: [dep("c")] }, c: { parent: "a", status: "done" } }));
  assert.deepEqual(parent.checks("a"), []); // a parent's derived done status counts as closed
});

test("open roots without a stored priority are flagged, including items whose dependents are all closed; items with an open dependent and closed roots are not", () => {
  assert.deepEqual(rules(snapshot({ a: {} })).checks("a"), [{ text: NO_PRIORITY }]);
  assert.deepEqual(rules(snapshot({ a: { head: "" } })).checks("a"), [{ text: NO_DONE_WHEN }, { text: NO_PRIORITY }]);
  assert.deepEqual(rules(snapshot({ a: { priority: "P1" } })).checks("a"), []);
  assert.deepEqual(rules(snapshot({ a: {}, w: { priority: "P1", deps: [dep("a")] } })).checks("a"), []);
  const left = rules(snapshot({ a: {}, w: { status: "done", priority: "P1", deps: [dep("a")] }, p: { priority: "P1", deps: [dep("a"), dep("c")] }, c: { parent: "p", status: "todo" } }));
  assert.equal(left.isRoot("a"), false); assert.deepEqual(left.checks("a"), []); // p is open
  const closed = rules(snapshot({ a: {}, w: { status: "done", priority: "P1", deps: [dep("a")] }, p: { priority: "P1", deps: [dep("a"), dep("c")] }, c: { parent: "p", status: "done" } }));
  assert.equal(closed.statusOf("p"), "done"); assert.equal(closed.isRoot("a"), true); // a parent counts by its derived status
  assert.deepEqual(closed.checks("a"), [{ text: NO_PRIORITY }]);
  for (const status of ["done", "cancelled"] as const) assert.deepEqual(rules(snapshot({ a: { status } })).checks("a"), [], status);
});

test("LEGACY PRIORITY: unmigrated written priority prefers open leaves, then done leaves, then cancelled leaves", () => {
  const cases: Array<[Partial<Item>, Partial<Item>, string]> = [
    [{ status: "todo", priority: "P2" }, { status: "done", priority: "P0" }, "P2"],
    [{ status: "todo", priority: "P2" }, { status: "cancelled", priority: "P0" }, "P2"],
    [{ status: "todo", priority: "P1" }, { status: "wip", priority: "P0" }, "P0"],
    [{ status: "done", priority: "P1" }, { status: "cancelled", priority: "P0" }, "P1"],
    [{ status: "cancelled", priority: "P2" }, { status: "cancelled", priority: "P1" }, "P1"],
    [{ status: "todo" }, { status: "done", priority: "P1" }, "P1"],
    [{}, {}, ""],
  ];
  for (const [a, b, expected] of cases) {
    const r = rules(legacy({ area: { priority: "P0" }, mid: { parent: "area" }, a: { parent: "mid", ...a }, b: { parent: "mid", ...b } }));
    assert.equal(r.writtenPriorityOf("area"), expected);
    assert.equal(r.writtenPriorityOf("mid"), expected);
  }
  assert.equal(rules(legacy({ leaf: { priority: "P2", status: "done" } })).writtenPriorityOf("leaf"), "P2");
});

test("LEGACY PRIORITY: unmigrated effective priority propagates through wait chains and ancestors, with a raising witness", () => {
  // Insert targets before waiters to require more than one relaxation pass.
  const r = rules(legacy({
    area: { deps: [dep("mid")], priority: "P0" }, mid: { parent: "area", deps: [dep("target")] },
    target: { parent: "mid", priority: "P2" }, chain: { priority: "P2", deps: [dep("area")] },
    urgent: { priority: "P0", deps: [dep("chain")] },
  }));
  assert.equal(r.writtenPriorityOf("target"), "P2");
  for (const id of ["area", "mid", "target", "chain"]) assert.equal(r.priorityOf(id), "P0", id);
  assert.equal(r.raisedBy("target"), "chain");
  assert.equal(r.raisedBy("mid"), "chain");
  assert.equal(r.raisedBy("area"), "chain");
  assert.equal(r.raisedBy("chain"), "urgent");
  assert.equal(r.raisedBy("urgent"), null);
});

test("LEGACY PRIORITY: in unmigrated projects ended and archived work do not raise priorities, and ancestors do not act as external waiters", () => {
  const r = rules(legacy({
    area: { deps: [dep("low"), dep("high")] }, low: { parent: "area", priority: "P2" }, high: { parent: "area", priority: "P0" },
    done: { status: "done", priority: "P0", deps: [dep("low")] }, cancelled: { status: "cancelled", priority: "P0", deps: [dep("low")] },
    archived: { priority: "P0", deps: [dep("low")] }, arChild: { parent: "archived", priority: "P0", deps: [dep("low")] },
    endTarget: { status: "done", priority: "P2" }, arTarget: { priority: "P2" },
    urgent: { priority: "P0", deps: [dep("endTarget"), dep("arTarget")] },
  }, {}, {}, { archived: T1, arTarget: T1 }));
  assert.equal(r.priorityOf("low"), "P2");
  assert.equal(r.raisedBy("low"), null);
  assert.equal(r.priorityOf("endTarget"), "P2");
  assert.equal(r.priorityOf("arTarget"), "P2");
  assert.equal(r.priorityOf("area"), "P0");
  const unset = rules(legacy({ target: {}, waiter: { priority: "P1", deps: [dep("target")] } }));
  assert.equal(unset.priorityOf("target"), "P1");
  assert.equal(unset.raisedBy("target"), "waiter");
});

test("one board gives the new results when its project is migrated and the legacy ones when board.yaml omits the field", () => {
  const items: Record<string, Partial<Item>> = { area: { priority: "P0", deps: [dep("leaf")], head: "" }, leaf: { parent: "area", priority: "P2", head: "" }, waiter: { priority: "P1", deps: [dep("leaf")] } };
  const now = rules(snapshot(items)), before = rules(legacy(items));
  assert.equal(now.migrated("leaf"), true); assert.equal(before.migrated("leaf"), false);
  assert.equal(now.priorityOf("leaf"), "P0"); assert.equal(now.raisedBy("leaf"), null); assert.equal(now.writtenPriorityOf("leaf"), "P2");
  assert.equal(before.priorityOf("leaf"), "P1"); assert.equal(before.raisedBy("leaf"), "waiter"); // the parent does not raise its own leaves
  assert.deepEqual(now.checks("area").map(c => c.text), [NO_DONE_WHEN]); assert.deepEqual(before.checks("area"), []);
  assert.deepEqual(before.checks("leaf"), []); assert.deepEqual(rules(legacy({ bare: { head: "" } })).checks("bare"), []); // no new flags, even on a root without priority or completion condition
});

test("a migrated dependent raises an unmigrated item without a struck original, and never lowers it", () => {
  const r = rules(projects(snapshot({
    goal: { group: "First", priority: "P0", deps: [dep("old")] },
    area: { group: "Second", priority: "P2", deps: [dep("old"), dep("sib")] }, old: { parent: "area", priority: "P2" }, sib: { parent: "area", priority: "P2", deps: [dep("lib")] },
    lib: { group: "Second", priority: "P2" }, low: { group: "First", priority: "P2", deps: [dep("high")] }, high: { group: "Second", priority: "P0" },
  }), ["First"]));
  assert.equal(r.migrated("goal"), true); assert.equal(r.migrated("old"), false);
  assert.equal(r.priorityOf("old"), "P0"); assert.equal(r.raisedBy("old"), null); assert.equal(r.writtenPriorityOf("old"), "P2");
  assert.equal(r.priorityOf("area"), "P0"); assert.equal(r.raisedBy("area"), null); // the parent shows its highest open leaf
  assert.equal(r.priorityOf("sib"), "P2"); assert.equal(r.priorityOf("lib"), "P2"); // the raise reaches only what waits under the migrated dependent
  assert.equal(r.priorityOf("high"), "P0"); // a lower migrated dependent leaves the legacy priority alone
  const mixed = rules(projects(snapshot({ goal: { group: "First", priority: "P1", deps: [dep("old")] }, old: { group: "Second", priority: "P2" }, urgent: { group: "Second", priority: "P0", deps: [dep("old")] } }), ["First"]));
  assert.equal(mixed.priorityOf("old"), "P0"); assert.equal(mixed.raisedBy("old"), "urgent"); // the legacy raise keeps its record
});

test("an unmigrated dependent gives a migrated item its effective priority, and counts for rootness", () => {
  const s = snapshot({
    waiter: { group: "Second", priority: "P2", deps: [dep("tool")] }, boss: { group: "Second", priority: "P0", deps: [dep("waiter")] },
    tool: { group: "First", priority: "P2", deps: [dep("part")] }, part: { parent: "tool" },
  });
  const r = rules(projects(s, ["First"]));
  assert.equal(r.priorityOf("waiter"), "P0"); assert.equal(r.raisedBy("waiter"), "boss");
  assert.equal(r.isRoot("tool"), false); assert.equal(r.priorityOf("tool"), "P0"); assert.equal(r.priorityOf("part"), "P0");
  assert.deepEqual(r.checks("tool"), []); // not a root: no flag for its ignored stored priority
  const closed = rules(projects({ ...s, items: { ...s.items, waiter: { ...s.items.waiter!, status: "done" } } }, ["First"]));
  assert.equal(closed.isRoot("tool"), true); assert.equal(closed.priorityOf("tool"), "P2");
});

test("records have no status and do not contribute status roll-up or status checks", () => {
  const s = snapshot({
    root: { status: "wip", priority: "P1", deps: [dep("record")] },
    record: { parent: "root", record: true, head: "Queue history", deps: [dep("cancelled")] },
    cancelled: { status: "cancelled", priority: "P2" },
  });
  let r = rules(s);
  assert.equal(r.statusOf("record"), undefined);
  assert.equal(r.statusOf("root"), "wip");
  assert.equal(r.isLeaf("root"), false);
  assert.equal(r.isStatusLeaf("root"), true);
  assert.equal(r.depsOf("root")[0]!.open, false);
  assert.equal(r.priorityOf("record"), "P1");
  assert.deepEqual(r.checks("record"), []);
  assert.ok(!r.checks("root").some(c => c.text.includes("还在等别的")));
  s.items.work = Item.parse({ title: "work", parent: "root", status: "done", updated: T0, rev: 1 });
  r = rules(s);
  assert.equal(r.statusOf("root"), "done");
  s.items.work.parent = "record";
  assert.equal(rules(s).statusOf("record"), undefined, "even a record with work children has no status");
  assert.equal(Item.safeParse({ ...s.items.record, status: "todo" }).success, false);
});

const hour = 60 * 60 * 1000, start = Date.parse(T0);
const timeAt = (hours: number) => new Date(start + hours * hour).toISOString();
function activeBoard(): Snapshot {
  const s = snapshot({ quiet: { status: "wip", priority: "P1" }, other: { status: "todo", priority: "P1", group: "Second" } });
  s.activity = { writes: Array.from({ length: 7 }, (_, i) => timeAt(i / 2)), items: { quiet: T0, other: timeAt(3) } };
  return s;
}
const hasStalled = (s: Snapshot, id = "quiet", hours = 3) => rules(s, start + hours * hour).checks(id).some(c => c.text.includes("活跃时间"));

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

test("each own document change resets a stalled leaf, including historical card or note revisions", () => {
  const changes: Array<(s: Snapshot) => void> = [
    s => { s.items.quiet!.updated = timeAt(2.5); },
    s => { s.items.quiet!.log.push({ at: timeAt(2.5), text: "Progress" }); },
    s => { s.decisions.card = Decision.parse({ item: "quiet", question: "Decision", background: "Evidence", options: [{ key: "A", text: "Proceed" }], status: "open", updated: timeAt(2.5), rev: 1 }); },
    s => { s.notes.note = Note.parse({ target: "it:quiet", kind: "comment", text: "Progress", at: timeAt(2.5), state: "sent", rev: 1 }); },
    s => { s.decisions.card = Decision.parse({ item: "quiet", question: "Decision", background: "Evidence", options: [{ key: "A", text: "Proceed" }], status: "open", updated: T0, rev: 1 }); s.notes.note = Note.parse({ target: "q:card", kind: "comment", text: "Progress", at: T0, repliedAt: timeAt(2.5), state: "done", rev: 1 }); },
    s => { s.activity!.items.quiet = timeAt(2.5); },
    s => { s.items.record = Item.parse({ title: "Queue", record: true, parent: "quiet", updated: timeAt(2.5), rev: 1 }); },
  ];
  for (const change of changes) {
    const s = activeBoard(); assert.equal(hasStalled(s), true);
    change(s); assert.equal(hasStalled(s), false);
  }
});

test("records, todo, done, blocked, cancelled and work parents never get stalled flags", () => {
  for (const status of ["todo", "done", "blocked", "cancelled"] as const) {
    const s = activeBoard(); s.items.quiet!.status = status; assert.equal(hasStalled(s), false, status);
  }
  const s = activeBoard(); delete s.items.quiet!.status; s.items.quiet!.record = true;
  assert.equal(hasStalled(s), false);
  delete s.items.quiet!.record;
  s.items.child = Item.parse({ title: "Child", parent: "quiet", status: "wip", updated: T0, rev: 1 });
  assert.equal(hasStalled(s), false); assert.equal(hasStalled(s, "child"), true);
});

test("current notice and note write times contribute active windows across projects", () => {
  const s = activeBoard(); delete s.activity;
  for (let i = 0; i < 6; i++) s.notices["notice" + i] = { text: "Changed", author: "Second", at: timeAt(i / 2), rev: 1 };
  assert.equal(hasStalled(s), true);
  s.notices = {};
  for (let i = 0; i < 6; i++) s.notes["note" + i] = Note.parse({ target: "it:other", kind: "comment", text: "Changed", at: timeAt(i / 2), state: "sent", rev: 1 });
  assert.equal(hasStalled(s), true);
});


test("step rules render markers, elapsed whole days and done ratio excluding dropped steps", () => {
  const steps = [
    { id: "done", text: "Checks pass #341", state: "done" as const, doneAt: T0 },
    { id: "doing", text: "Review complete", state: "doing" as const, since: T0, waits: "Owner" },
    { id: "todo", text: "Merged", state: "todo" as const },
    { id: "dropped", text: "Old approach", state: "dropped" as const, droppedAt: T1, reason: "Replaced" },
  ];
  const s = snapshot({ item: { steps }, record: { record: true, steps }, empty: {}, onlyDropped: { steps: [steps[3]!] } });
  const r = rules(s, Date.parse(T2));
  assert.deepEqual(r.stepsRatio("item"), { done: 1, total: 3 });
  assert.deepEqual(r.stepsRatio("record"), { done: 1, total: 3 });
  assert.deepEqual(r.stepsRatio("empty"), { done: 0, total: 0 });
  assert.deepEqual(r.stepsRatio("onlyDropped"), { done: 0, total: 0 });
  assert.equal(r.statusOf("item"), "todo", "steps do not derive work status");
  assert.equal(r.statusOf("record"), undefined);
  assert.deepEqual(steps.map(r.stepLine), ["✓ Checks pass #341 (10-10)", "● Review complete — 2 天，等 Owner", "○ Merged", "✗ Old approach — Replaced"]);
  assert.equal(rules(s, Date.parse(T1) - 1).stepDays(steps[1]!), 0, "whole-day boundary");
  assert.equal(rules(s, Date.parse(T1)).stepDays(steps[1]!), 1);
  assert.equal(rules(s, Date.parse(T0) - 1).stepDays(steps[1]!), 0, "future since clamps to zero");
  assert.equal(r.stepDays(steps[2]!), 0);
});

test("stored step schemas require state dates and dropped reasons but old items omit steps", () => {
  assert.equal(Object.hasOwn(Item.parse({ title: "Old", updated: T0, rev: 1 }), "steps"), false);
  const spaced = { id: "spaced", text: "  Exact step text  ", state: "dropped" as const, reason: "  Exact reason  ", waits: "  Exact wait  ", droppedAt: T0 };
  assert.deepEqual(ItemStep.parse(spaced), spaced, "schema reads preserve prose exactly");
  for (const [state, date] of [["done", "doneAt"], ["doing", "since"], ["dropped", "droppedAt"]] as const) {
    const input = { id: "x", text: "Result", state, ...(state === "dropped" ? { reason: "No longer needed" } : {}) };
    assert.equal(ItemStepInput.safeParse(input).success, true);
    assert.equal(ItemStep.safeParse(input).success, false);
    assert.equal(ItemStep.safeParse({ ...input, [date]: T0 }).success, true);
    assert.equal(ItemStepInput.safeParse({ ...input, [date]: T0 }).success, false, "callers cannot set server dates");
  }
  assert.equal(ItemStepInput.safeParse({ id: "x", text: "Result", state: "dropped", reason: " " }).success, false);
  assert.equal(Item.safeParse({ title: "Bad", updated: T0, rev: 1, steps: [{ id: "same", text: "A", state: "todo" }, { id: "same", text: "B", state: "todo" }] }).success, false);
});

test("step freshness compares full values by stable id and separates reorder or removal from changed lines", () => {
  const a = { id: "a", text: "A", state: "doing" as const, since: T0 };
  const b = { id: "b", text: "B", state: "done" as const, doneAt: T1 };
  assert.deepEqual(changedItemSteps(undefined, [a, b]), [a, b]);
  assert.deepEqual(changedItemSteps([a, b], [b, a]), []);
  assert.equal(stepsChanged([a, b], [b, a]), true);
  assert.deepEqual(changedItemSteps([a, b], [b]), []);
  assert.equal(stepsChanged([a, b], [b]), true);
  assert.equal(stepsChanged(undefined, []), false);
  assert.equal(stepsChanged([a, b], [{ ...a }, { ...b }]), false);
  for (const changed of [{ ...a, text: "Revised A" }, { ...a, waits: "CI" }, { ...a, since: T1 }, { ...a, doneAt: T1 }, { ...a, reason: "Changed context" }]) {
    assert.deepEqual(changedItemSteps([a, b], [changed, b]), [changed]);
    assert.equal(stepsChanged([a, b], [changed, b]), true);
  }
});

test("the stalled check carries the visible label 无人推进 while other checks keep 需核对, and parents count stalled leaves below", () => {
  const s = activeBoard();
  s.items.child = Item.parse({ title: "Child", parent: "quiet", status: "wip", updated: T0, rev: 1 });
  s.items.child2 = Item.parse({ title: "Child 2", parent: "quiet", status: "wip", updated: T0, rev: 1 });
  s.items.fresh = Item.parse({ title: "Fresh", parent: "quiet", status: "wip", updated: timeAt(2.9), rev: 1 });
  const r = rules(s, start + 3 * hour), stalled = r.checks("child").find(c => c.text.includes("活跃时间"))!;
  assert.equal(stalled.label, STALLED_LABEL); assert.equal(checkLabel(stalled), "无人推进");
  assert.equal(checkLabel({}), "需核对", "a check without its own label is 需核对");
  assert.ok(r.checks("child").filter(c => c.text !== stalled.text).every(c => checkLabel(c) === "需核对"), "checks() returns copies, so compare by text");
  assert.equal(r.stalledBelow("quiet"), 2, "the folded parent counts child and child2 but not the recently changed fresh");
  assert.equal(r.stalledBelow("child"), 1); assert.equal(r.stalledBelow("fresh"), 0); assert.equal(r.stalledBelow("other"), 0);
});

test("log entries never count as owner-unread: one rule drops the log and names log-only change summaries", () => {
  assert.deepEqual(withoutLog({ title: "T", log: [{ at: T0, text: "x" }] }), { title: "T" });
  assert.deepEqual(["+2 log", "log changed"].map(isLogChange), [true, true]);
  assert.deepEqual(["steps changed", "head changed", "+2 logs here"].map(isLogChange), [false, false, false]);
});
