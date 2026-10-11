import assert from "node:assert/strict";
import test from "node:test";
import { Decision, Item, Note } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { rules } from "../src/rules.ts";

const T0 = "2026-10-10T00:00:00Z", T1 = "2026-10-11T00:00:00Z", T2 = "2026-10-12T00:00:00Z";
function snapshot(items: Record<string, Partial<Item>>, decisions: Record<string, Partial<Decision>> = {}, notes: Record<string, Partial<Note>> = {}, archived: Record<string, string> = {}): Snapshot {
  return {
    board: { title: "Synthetic" }, head: "0".repeat(40),
    items: Object.fromEntries(Object.entries(items).map(([id, fields]) => [id, Item.parse({ title: id, agent: "session", updated: T0, rev: 1, ...fields })])),
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
    c2: { parent: "a", order: 2, agent: undefined }, c1: { parent: "a", order: 1, agent: "handover" },
    leaf: { parent: "c1", agent: undefined }, orphan: { parent: "absent", agent: undefined },
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
  assert.deepEqual(r.areas(), ["a2", "a", "z"]);
  assert.deepEqual(r.ancestors("leaf"), ["c1", "a"]);
  assert.deepEqual(r.ancestors("orphan"), []);
  assert.equal(r.lineOf("leaf"), "a");
  assert.equal(r.lineOf("a"), "a");
  assert.equal(r.groupOf("leaf"), "First");
  assert.equal(r.agentFor("c2"), "session");
  assert.equal(r.agentFor("leaf"), "handover");
  assert.equal(r.agentFor("orphan"), "");
  assert.equal(r.isLeaf("a"), false);
  assert.equal(r.isLeaf("leaf"), true);
  assert.equal(r.lineOf("absent"), "absent");
  assert.equal(r.groupOf("absent"), "");
  assert.equal(r.agentFor("absent"), "");
  assert.equal(r.isLeaf("absent"), false); // dangling children remain indexed
  assert.equal(r.statusOf("unknown"), "todo");
  assert.equal(r.priorityOf("unknown"), "");
  assert.equal(r.effectivePriorityOf("unknown"), "");
  assert.equal(r.raisedBy("unknown"), null);
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

test("priority prefers open leaves, then done leaves, then cancelled leaves", () => {
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
    const r = rules(snapshot({ area: { priority: "P0" }, mid: { parent: "area" }, a: { parent: "mid", ...a }, b: { parent: "mid", ...b } }));
    assert.equal(r.priorityOf("area"), expected);
    assert.equal(r.priorityOf("mid"), expected);
  }
  assert.equal(rules(snapshot({ leaf: { priority: "P2", status: "done" } })).priorityOf("leaf"), "P2");
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

test("effective priority propagates through wait chains and ancestors, with a raising witness", () => {
  // Insert targets before waiters to require more than one relaxation pass.
  const r = rules(snapshot({
    area: { deps: [dep("mid")], priority: "P0" }, mid: { parent: "area", deps: [dep("target")] },
    target: { parent: "mid", priority: "P2" }, chain: { priority: "P2", deps: [dep("area")] },
    urgent: { priority: "P0", deps: [dep("chain")] },
  }));
  assert.equal(r.priorityOf("target"), "P2");
  for (const id of ["area", "mid", "target", "chain"]) assert.equal(r.effectivePriorityOf(id), "P0", id);
  assert.equal(r.raisedBy("target"), "chain");
  assert.equal(r.raisedBy("mid"), "chain");
  assert.equal(r.raisedBy("area"), "chain");
  assert.equal(r.raisedBy("chain"), "urgent");
  assert.equal(r.raisedBy("urgent"), null);
});

test("ended and archived work do not raise priorities, and ancestors do not act as external waiters", () => {
  const r = rules(snapshot({
    area: { deps: [dep("low"), dep("high")] }, low: { parent: "area", priority: "P2" }, high: { parent: "area", priority: "P0" },
    done: { status: "done", priority: "P0", deps: [dep("low")] }, cancelled: { status: "cancelled", priority: "P0", deps: [dep("low")] },
    archived: { priority: "P0", deps: [dep("low")] }, arChild: { parent: "archived", priority: "P0", deps: [dep("low")] },
    endTarget: { status: "done", priority: "P2" }, arTarget: { priority: "P2" },
    urgent: { priority: "P0", deps: [dep("endTarget"), dep("arTarget")] },
  }, {}, {}, { archived: T1, arTarget: T1 }));
  assert.equal(r.effectivePriorityOf("low"), "P2");
  assert.equal(r.raisedBy("low"), null);
  assert.equal(r.effectivePriorityOf("endTarget"), "P2");
  assert.equal(r.effectivePriorityOf("arTarget"), "P2");
  assert.equal(r.effectivePriorityOf("area"), "P0");
  const unset = rules(snapshot({ target: {}, waiter: { priority: "P1", deps: [dep("target")] } }));
  assert.equal(unset.effectivePriorityOf("target"), "P1");
  assert.equal(unset.raisedBy("target"), "waiter");
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
  assert.equal(r.effectivePriorityOf("a"), "P0");
  assert.equal(r.effectivePriorityOf("b"), "P0");
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
  why: "依赖没写为什么：", cycle: "依赖成环", agent: "顶层条目没有负责会话（agent）", parent: "上级条目不存在：missing",
  unlisted: "上级没有把它列在依赖里（上级必须是直接依赖它的条目）：", unblock: "可解除阻塞：等的都已完成",
  blocker: "卡住了，但没写在等什么", wip: "标为进行中，但还在等别的",
};
test("every legacy check has the exact text, condition, suppression and target", () => {
  const cases: Array<[Partial<Item>, Record<string, Partial<Item>>, Array<{ text: string; target?: { kind: "item"; id: string } }>]> = [
    [{ deps: [dep("missing")] }, {}, [{ text: C.missing }]],
    [{ deps: [dep("cancelled", "")] }, { cancelled: { status: "cancelled" } }, [{ text: C.cancelled, target: { kind: "item", id: "cancelled" } }]],
    [{ deps: [dep("other", "")] }, { other: {} }, [{ text: C.why, target: { kind: "item", id: "other" } }]],
    [{ status: "done", deps: [dep("other", "")] }, { other: {} }, []],
    [{ status: "cancelled", deps: [dep("other", "")] }, { other: {} }, []],
    [{ deps: [dep("a")] }, {}, [{ text: C.cycle }]],
    [{ agent: undefined }, {}, [{ text: C.agent }]],
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
  for (const [a, others, expected] of cases) assert.deepEqual(rules(snapshot({ a, ...others })).checks("a"), expected, JSON.stringify(a));
  assert.deepEqual(rules(snapshot({ a: { status: "blocked", deps: [dep("missing")] } }, {}, {}, { a: T1 })).checks("a"), []);
});

test("card deps participate in missing/why/wip/blocker checks but not item cycles or priority raising", () => {
  const r = rules(snapshot({
    a: { status: "blocked", deps: [card("q")] }, b: { status: "blocked", deps: [card("closed")] },
    c: { status: "blocked", deps: [card("absent")] }, d: { status: "wip", deps: [card("q", "")] },
    urgent: { priority: "P0", deps: [card("q")] }, host: { priority: "P2" },
  }, { q: { item: "host" }, closed: { item: "host", status: "ruled" } }, { choice: { target: "q:q", kind: "choice" } }));
  assert.deepEqual(r.checks("a"), []); // sent choice does not close an open dependency
  assert.deepEqual(r.checks("b"), [{ text: C.unblock }]);
  assert.deepEqual(r.checks("c"), [{ text: C.missingCard }, { text: C.unblock }]);
  assert.deepEqual(r.checks("d"), [{ text: C.why, target: { kind: "card", id: "q" } }, { text: C.wip, target: { kind: "card", id: "q" } }]);
  assert.equal(r.onCycle("host"), false);
  assert.equal(r.effectivePriorityOf("host"), "P2");
  const ownCard = rules(snapshot({ a: { status: "blocked" } }, { q: { item: "a" } }));
  assert.deepEqual(ownCard.checks("a"), []);
  const answeredCard = rules(snapshot({ a: { status: "blocked" } }, { q: { item: "a" } }, { n: { target: "q:q", kind: "choice" } }));
  assert.deepEqual(answeredCard.checks("a"), [{ text: C.blocker }]);
});

test("sibling sorting uses effective priority, then open/ended, then order", () => {
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
  const s = snapshot({ a: { deps: [dep("b", "")] }, b: { parent: "a" } }, { q: { item: "b" } });
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
  r.statusOf("a"); r.priorityOf("a"); r.effectivePriorityOf("a"); r.onCycle("a"); r.needsOwner("b");
  assert.deepEqual(s, before);
  const next = { ...s, items: { ...s.items, b: { ...s.items.b!, status: "done" as const, priority: "P0" as const } } };
  assert.equal(rules(next).statusOf("a"), "done");
  assert.equal(r.statusOf("a"), "todo");
});
