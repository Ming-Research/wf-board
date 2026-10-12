import assert from "node:assert/strict";
import test from "node:test";
import { Decision, Item, Note } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { rules } from "../src/rules.ts";

const T0 = "2026-10-10T00:00:00Z", T1 = "2026-10-11T00:00:00Z", T2 = "2026-10-12T00:00:00Z";
// Items state a completion condition unless a case is about a head without one.
const DONE_WHEN = "**完成条件**：测试通过";
function snapshot(items: Record<string, Partial<Item>>, decisions: Record<string, Partial<Decision>> = {}, notes: Record<string, Partial<Note>> = {}, archived: Record<string, string> = {}): Snapshot {
  return {
    board: { title: "Synthetic", projects: ["Default","First","Second"].map(name => ({name})) }, head: "0".repeat(40),
    items: Object.fromEntries(Object.entries(items).map(([id, fields]) => [id, Item.parse({ title: id, group: "Default", head: DONE_WHEN, updated: T0, rev: 1, ...fields })])),
    decisions: Object.fromEntries(Object.entries(decisions).map(([id, fields]) => [id, Decision.parse({ item: "area", question: id, background: "why", options: [{ key: "A", text: "choose" }], status: "open", updated: T0, rev: 1, ...fields })])),
    notes: Object.fromEntries(Object.entries(notes).map(([id, fields]) => [id, Note.parse({ target: "it:area", kind: "comment", text: "note", at: T0, state: "sent", rev: 1, ...fields })])),
    owner: { archived },
  };
}
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
  const s: Snapshot = { board: { title: "Projects", projects: [{ name: "P" }, { name: "Empty" }] }, head: "", owner: { archived: {} }, notes: {}, decisions: {}, items: {} };
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
