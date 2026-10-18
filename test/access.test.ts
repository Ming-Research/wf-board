// The permission table (model ACCESS) and its enforcement in ops.run: what each role may write, and where.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCESS, ARCHITECT_WRITER, PARTS, PROCESS_WRITERS, ROLES, writesAnyProject } from "../src/model.ts";
import type { Access, Part, Role } from "../src/model.ts";
import { OpError } from "../src/ops.ts";
import type { Ops } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import { board, asArchitect, asPM, rx } from "./helpers.ts";

const grants = (role: Role) => Object.entries(ACCESS[role]).map(([part, scope]) => `${part}:${scope}`).sort();
// What the design (docs/design.md, section 9) reserves for the PM and the architect, written out here and not read from the table.
const PROCESS: Part[] = ["item.create", "item.title", "item.difficulty", "item.cancel", "item.pause", "item.move-project", "item.runner", "dispatch.start", "dispatch.finish"];
// What only the architect may do beyond that (no role has the merge row: the GitHub watch marks it).
const ARCHITECT_ONLY: Part[] = ["project.create", "tag-vocab", "journal", "item.merge-row"];
const RESERVED: Part[] = [...PROCESS, ...ARCHITECT_ONLY];

test("each role has the parts the design gives it", () => {
  assert.deepEqual(grants("审查"), ["item.log:subtree", "message.send:own"]);
  assert.deepEqual(grants("工程师"), ["card.write:subtree", "item.create:subtree", "item.difficulty:below", "item.head:subtree", "item.links:subtree", "item.log:subtree", "item.plan:subtree", "item.tags:subtree", "item.targets:subtree", "message.send:own", "note.reply:subtree", "term:subtree"]);
  assert.deepEqual(grants("资源管理"), ["dispatch.finish:board", "item.head:subtree", "item.log:board", "item.plan:subtree", "message.send:own"]);
  // Every role sends messages, and a message changes no item: its scope is the sender's own.
  const items = (parts: readonly Part[]) => parts.filter(p => p !== "message.send").map(p => `${p}:board`);
  assert.deepEqual(grants("架构师"), [...items(PARTS.filter(p => p !== "item.merge-row")), "message.send:own"].sort());
  assert.deepEqual(grants("PM"), [...items(PARTS.filter(p => !ARCHITECT_ONLY.includes(p))), "message.send:own"].sort(), "the PM has the process parts, not the journal, the tag vocabulary or a new project");
  assert.deepEqual(grants("观察者"), [...items(PARTS.filter(p => !RESERVED.includes(p))), "message.send:own"].sort());
  assert.deepEqual(ROLES.filter(writesAnyProject), ["架构师", "PM", "观察者", "资源管理"], "the engineer and the review write inside their own project only");
});

test("the writes the code reserves are the parts the table withholds from the observer, and the PM has all but the architect's own", async t => {
  const { op } = await board(t);
  const legacy = { author: "Whitefoot", session: "someone" };
  const reserved: Array<[Part, RegExp, () => Promise<unknown>]> = [
    ["item.create", rx`only ${PROCESS_WRITERS}`, () => op.createItem({ ...legacy, key: "n", title: "N", accept: "ok", group: "Whitefoot" })],
    ["journal", rx`only ${ARCHITECT_WRITER} may write the journal`, () => op.journalEntry({ ...legacy, text: "x" })],
    ["item.difficulty", rx`only ${PROCESS_WRITERS}`, () => op.setDifficulty({ ...legacy, id: "a", difficulty: 2, reason: "r" })],
    ["tag-vocab", rx`only ${ARCHITECT_WRITER} may change the tag vocabulary`, () => op.setTag({ ...legacy, name: "标签", meaning: "m" })],
    ["item.pause", rx`only ${PROCESS_WRITERS}`, () => op.setPause({ ...legacy, id: "a", paused: true, reason: "r" })],
    ["item.move-project", rx`only ${PROCESS_WRITERS}`, () => op.moveItemProject({ ...legacy, id: "a", project: "Firn" })],
    ["item.cancel", rx`only ${PROCESS_WRITERS}`, () => op.setStatus({ ...legacy, id: "a", status: "cancelled", log: "l" })],
    ["item.title", rx`only ${PROCESS_WRITERS}`, () => op.updateItem({ ...legacy, id: "a", rev: 1, title: "new title" })],
    ["item.runner", rx`only ${PROCESS_WRITERS} may report the runner's state`, () => op.reportState({ ...legacy, id: "a", state: "running" })],
  ];
  for (const [part, message, call] of reserved) {
    await assert.rejects(call, (error: unknown) => error instanceof OpError && message.test(error.message), `${part}: the code refuses an author that is neither the PM nor the architect`);
    assert.equal(ACCESS["观察者"][part], undefined, `${part}: and the observer's credential has no such part`);
    assert.ok(ACCESS["架构师"][part], `${part}: the architect's has`);
    assert.equal(ACCESS.PM[part] !== undefined, PROCESS.includes(part), `${part}: the PM's has it exactly when it is a process part`);
  }
});

// A call for every write, with the parts it changes. The arguments only have to be present: the table is asked before they are read.
const calls: Record<keyof Ops, Array<{ parts: Part[]; args: Record<string, unknown> }>> = {
  createProject: [{ parts: ["project.create"], args: { name: "N" } }],
  updateProject: [{ parts: ["project.update"], args: { name: "Whitefoot", repo: "o/r" } }],
  closeNote: [{ parts: ["note.close"], args: { id: "note-1", log: "l" } }],
  createItem: [{ parts: ["item.create"], args: { key: "n", title: "N", accept: "ok", group: "Whitefoot" } }],
  appendLog: [{ parts: ["item.log"], args: { id: "a", text: "t" } }],
  markMerged: [{ parts: ["item.merge-row"], args: { id: "a", row: "r", merged: [], log: "l" } }],
  journalEntry: [{ parts: ["journal"], args: { text: "t" } }],
  dispatchStart: [{ parts: ["dispatch.start"], args: { id: "a", role: "工程师", level: 2, model: "m", agent: "g", agentId: "i" } }],
  dispatchFinish: [{ parts: ["dispatch.finish"], args: { id: "a", agentId: "i", result: "一次通过", usage: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }, cost: 1 } }],
  reportState: [{ parts: ["item.runner"], args: { id: "a", state: "running" } }],
  setPlan: [{ parts: ["item.plan"], args: { id: "a", remove: "r" } }],
  setTargets: [{ parts: ["item.targets"], args: { id: "a", remove: "r" } }],
  updateItem: [
    { parts: ["item.title"], args: { id: "a", rev: 1, title: "t" } }, { parts: ["item.head"], args: { id: "a", rev: 1, head: "h", reason: "r" } },
    { parts: ["item.links"], args: { id: "a", rev: 1, links: [] } },
    { parts: ["item.data"], args: { id: "a", rev: 1, data: "d" } }, { parts: ["item.order"], args: { id: "a", rev: 1, order: 1 } },
    { parts: ["item.record"], args: { id: "a", rev: 1, record: true } }, { parts: ["item.head", "item.links"], args: { id: "a", rev: 1, head: "h", reason: "r", links: [] } },
  ],
  setStatus: [{ parts: ["item.cancel", "card.write"], args: { id: "a", status: "cancelled", log: "l" } }],
  setTags: [{ parts: ["item.tags"], args: { id: "a", tags: ["t"] } }],
  setTagsMany: [{ parts: ["item.tags"], args: { items: [{ id: "a", tags: ["t"] }] } }],
  setDifficulty: [{ parts: ["item.difficulty"], args: { id: "a", difficulty: 2, reason: "r" } }],
  setDifficultyMany: [{ parts: ["item.difficulty"], args: { items: [{ id: "a", difficulty: 2 }], reason: "r" } }],
  setTag: [{ parts: ["tag-vocab"], args: { name: "标签", meaning: "m" } }],
  renameTag: [{ parts: ["tag-vocab"], args: { name: "标签", to: "新" } }],
  removeTag: [{ parts: ["tag-vocab"], args: { name: "标签" } }],
  setPause: [{ parts: ["item.pause"], args: { id: "a", paused: true, reason: "r" } }],
  moveItem: [{ parts: ["item.move"], args: { id: "a" } }],
  moveItemProject: [{ parts: ["item.move-project"], args: { id: "a", project: "Firn" } }],
  clearAsk: [{ parts: ["item.ask"], args: { id: "a", log: "l" } }],
  writeCard: [{ parts: ["card.write", "item.plan", "item.log"], args: { key: "k", item: "a", question: "q", confidence: { reason: "r" }, options: [{ text: "t", detail: "d" }] } }],
  ruleCard: [{ parts: ["card.rule"], args: { key: "choice", ruling: "r" } }],
  withdrawCard: [{ parts: ["card.write", "item.log"], args: { key: "choice", log: "l" } }],
  replyNote: [{ parts: ["note.reply"], args: { id: "note-1", reply: "r" } }],
  setTerm: [{ parts: ["term"], args: { term: "词", definition: "d" } }],
  deleteTerm: [{ parts: ["term"], args: { term: "词" } }],
  sendMessage: [{ parts: ["message.send"], args: { to: "架构师", text: "t" } }],
};

test("every write the board has is asked about the table, for every role", async t => {
  const { op } = await board(t);
  assert.deepEqual(Object.keys(op).sort(), Object.keys(calls).sort(), "a write that this list lacks was added without a part");
  let refusals = 0, passes = 0;
  for (const role of ROLES) {
    const access: Access = { role, project: "Whitefoot", roots: ["a"] };
    for (const [name, variants] of Object.entries(calls)) for (const { parts, args } of variants) {
      const call = () => (op[name as keyof Ops] as unknown as (a: unknown) => Promise<unknown>)({ author: "Whitefoot", session: "s", access, ...args });
      const missing = parts.filter(part => ACCESS[role][part] === undefined);
      if (missing.length) {
        refusals++;
        await assert.rejects(call, (error: unknown) => error instanceof OpError && error.message.startsWith(`${missing.join(", ")}: a ${role} credential may not write`), `${role} / ${name} ${parts.join("+")} is refused`);
      } else {
        passes++;
        // Whatever else the call runs into, it is not the table that stops it.
        await call().catch((error: unknown) => assert.ok(!(error instanceof OpError && /credential may not write/.test(error.message)), `${role} / ${name} ${parts.join("+")}: ${String(error)}`));
      }
    }
  }
  assert.ok(refusals > 50 && passes > 20, `the matrix covered ${refusals} refusals and ${passes} passes`);
});

const engineer = (roots: string[]): Access => ({ role: "工程师", project: "Whitefoot", roots });

test("an engineer's credential writes inside its subtree only", async t => {
  const { op, store } = await board(t);
  const who = (roots: string[]) => ({ author: "Whitefoot", session: "eng", access: engineer(roots) });
  // Item `area` owns a and b: the subtree of area holds all three; the subtree of a only itself.
  await op.appendLog({ ...who(["area"]), id: "a", text: "inside" });
  await op.appendLog({ ...who(["area"]), id: "b", text: "inside too" });
  await op.appendLog({ ...who(["a"]), id: "a", text: "its own item" });
  const before = store.snapshot().head;
  await assert.rejects(op.appendLog({ ...who(["a"]), id: "b", text: "a sibling" }), (e: unknown) => e instanceof OpError && /item b: outside the subtree of a/.test(e.message));
  await assert.rejects(op.setPlan({ ...who(["a"]), id: "b", row: { id: "w", text: "work", state: "doing" } }), (e: unknown) => e instanceof OpError && /outside the subtree/.test(e.message));
  // Another project's item is refused by the ownership rule that applies without any credential.
  await assert.rejects(op.appendLog({ ...who(["area"]), id: "other", text: "other project" }), (e: unknown) => e instanceof OpError && /item other belongs to project Firn/.test(e.message));
  assert.equal(store.snapshot().head, before, "no refused write was made");
  assert.equal(store.snapshot().items.a!.log.at(-1)!.by, "Whitefoot");
});

test("a card is written inside the subtree only, and a write that reaches another item through its effects is refused", async t => {
  const { op, store } = await board(t);
  const who = { author: "Whitefoot", session: "eng", access: engineer(["a"]) };
  const card = { key: "q-new", question: "q", confidence: { reason: "r" }, options: [{ text: "t", detail: "d" }] };
  await op.writeCard({ ...who, ...card, item: "a" });
  assert.equal(store.snapshot().decisions["q-new"]!.item, "a");
  await assert.rejects(op.writeCard({ ...who, ...card, key: "q-other", item: "b" }), (e: unknown) => e instanceof OpError && /item b: outside the subtree/.test(e.message));
  // A move changes the owners of both items: it is not a part an engineer has.
  await assert.rejects(op.moveItem({ ...who, id: "a", owner: "b" }), (e: unknown) => e instanceof OpError && /item\.move: a 工程师 credential may not write/.test(e.message));
});

test("a subtree credential cannot take an item into its subtree", async t => {
  const { op, store } = await board(t);
  const who = { author: "Whitefoot", session: "eng", access: engineer(["a"]) };
  // An own row for an unowned top item of the same project would put it under the subtree, where the credential then writes.
  await op.createItem({ ...asArchitect, key: "free", title: "Free", record: true, group: "Whitefoot" });
  const head = store.snapshot().head;
  await assert.rejects(op.setPlan({ ...who, id: "a", row: { item: "free", own: true } }), (e: unknown) => e instanceof OpError && /item free: outside the subtree of a/.test(e.message));
  assert.equal(store.snapshot().head, head);
  // The same rows are what the architect writes.
  await op.setPlan({ ...asArchitect, id: "a", row: { item: "free", own: true } });
  assert.equal(store.snapshot().items.a!.plan!.some(r => "item" in r && r.item === "free" && r.own), true);
  // A row that owns an item already inside the subtree stays allowed.
  await op.setPlan({ ...who, id: "a", row: { id: "w", text: "work", state: "doing" } });
  await op.appendLog({ ...who, id: "free", text: "inside now" });
});

test("a credential speaks for the architect by its role, whatever author and session it carries", async t => {
  const { op, store } = await board(t);
  // Author Architect from the session 架构师 is what the board takes for the architect when nothing else tells; a credential of
  // another role is not the architect's, so it has no right over another project's items (`a` belongs to Whitefoot).
  const head = store.snapshot().head;
  const engineerAsArchitect = { author: "Architect", session: "架构师", access: { role: "工程师" as const, project: "Architect", roots: ["a"] } };
  await assert.rejects(op.appendLog({ ...engineerAsArchitect, id: "a", text: "x" }), (e: unknown) => e instanceof OpError && /item a belongs to project Whitefoot/.test(e.message));
  assert.equal(store.snapshot().head, head);
  // The architect's own credential does.
  await op.appendLog({ author: "Architect", session: "架构师", access: { role: "架构师" as const, project: "Architect", roots: [] }, id: "a", text: "from the architect" });
  assert.equal(store.snapshot().items.a!.log.at(-1)!.text, "from the architect");
});

test("a review writes the log of its subtree and nothing else", async t => {
  const { op } = await board(t);
  const who = { author: "Whitefoot", session: "rev", access: { role: "审查" as const, project: "Whitefoot", roots: ["a"] } };
  await op.appendLog({ ...who, id: "a", text: "findings" });
  await assert.rejects(op.setPlan({ ...who, id: "a", row: { id: "w", text: "work", state: "doing" } }), (e: unknown) => e instanceof OpError && /item\.plan: a 审查 credential may not write/.test(e.message));
  await assert.rejects(op.updateItem({ ...who, id: "a", rev: 1, head: "h", reason: "r" }), (e: unknown) => e instanceof OpError && /item\.head: a 审查 credential may not write/.test(e.message));
});

test("the observer writes items of any project, but nothing the architect reserves", async t => {
  const { op, store } = await board(t);
  const who = { author: "Architect", session: "观察者", access: { role: "观察者" as const, project: "Architect", roots: [] } };
  await op.appendLog({ ...who, id: "other", text: "rule change" });
  assert.equal(store.snapshot().items.other!.log.at(-1)!.by, "Architect");
  await op.updateItem({ ...who, id: "a", rev: store.snapshot().items.a!.rev, head: "new head", reason: "rules" });
  await assert.rejects(op.createItem({ ...who, key: "n", title: "N", accept: "ok", group: "Architect" }), (e: unknown) => e instanceof OpError && /item\.create: a 观察者 credential may not write/.test(e.message));
  await assert.rejects(op.setDifficulty({ ...who, id: "a", difficulty: 2, reason: "r" }), (e: unknown) => e instanceof OpError && /may not write/.test(e.message));
});

test("the resource agent writes any log, and the head and plan of its own records only", async t => {
  const { op, store } = await board(t);
  const who = { author: "Architect", session: "资源管理", access: { role: "资源管理" as const, project: "Architect", roots: ["a"] } };
  await op.appendLog({ ...who, id: "other", text: "run finished" });
  await op.updateItem({ ...who, id: "a", rev: store.snapshot().items.a!.rev, head: "queue", reason: "queue changed" });
  await op.setPlan({ ...who, id: "a", row: { id: "w", text: "run", state: "doing" } });
  await assert.rejects(op.updateItem({ ...who, id: "b", rev: store.snapshot().items.b!.rev, head: "x", reason: "r" }), (e: unknown) => e instanceof OpError && /item b: outside the subtree of a/.test(e.message));
  await assert.rejects(op.setTargets({ ...who, id: "a", remove: "t" }), (e: unknown) => e instanceof OpError && /may not write/.test(e.message));
});

test("a credential speaks for the PM by its role, whatever author and session it carries", async t => {
  const { op, store } = await board(t);
  const head = store.snapshot().head;
  // Author PM from the session PM is what the board takes for the PM when nothing else tells; a credential of another
  // role is not the PM's, so it has no right over another project's items (`a` belongs to Whitefoot).
  const engineerAsPM = { ...asPM, access: { role: "工程师" as const, project: "PM", roots: ["a"] } };
  await assert.rejects(op.appendLog({ ...engineerAsPM, id: "a", text: "x" }), (e: unknown) => e instanceof OpError && /item a belongs to project Whitefoot/.test(e.message));
  await assert.rejects(op.createItem({ ...engineerAsPM, key: "n", title: "N", accept: "ok", group: "Whitefoot" }), (e: unknown) => e instanceof OpError && /item n: outside the subtree of a, the only items a 工程师 credential writes for item\.create/.test(e.message));
  assert.equal(store.snapshot().head, head);
  // The PM's own credential does, with other names than the PM's.
  await op.appendLog({ author: "Whitefoot", session: "other-name", access: { role: "PM" as const, project: "PM", roots: [] }, id: "a", text: "from the PM" });
  assert.equal(store.snapshot().items.a!.log.at(-1)!.text, "from the PM");
});

test("the PM's credential does what the process needs in any project, and not what only the architect does", async t => {
  const { op, store } = await board(t);
  const who = { ...asPM, access: { role: "PM" as const, project: "PM", roots: [] } };
  await op.createItem({ ...who, key: "made", title: "Made", accept: "ok", group: "Whitefoot" });
  await op.setDifficulty({ ...who, id: "made", difficulty: 2, reason: "r" });
  await op.setPause({ ...who, id: "made", paused: true, reason: "later" });
  await op.setPause({ ...who, id: "made", paused: false });
  await op.moveItemProject({ ...who, id: "made", project: "Firn" });
  await op.setStatus({ ...who, id: "made", status: "cancelled", log: "not needed" });
  await op.appendLog({ ...who, id: "other", text: "from the PM" });
  assert.equal(store.snapshot().items.made!.group, "Firn");
  assert.equal(store.snapshot().items.other!.log.at(-1)!.by, "PM");
  await assert.rejects(op.journalEntry({ ...who, text: "x" }), (e: unknown) => e instanceof OpError && /journal: a PM credential may not write/.test(e.message));
  await assert.rejects(op.setTag({ ...who, name: "标签", meaning: "m" }), (e: unknown) => e instanceof OpError && /tag-vocab: a PM credential may not write/.test(e.message));
  await assert.rejects(op.createProject({ ...who, name: "New" }), (e: unknown) => e instanceof OpError && /project\.create: a PM credential may not write/.test(e.message));
});

test("the architect's credential does what the architect does, in any project", async t => {
  const { op, store } = await board(t);
  const who = { author: "Architect", session: "架构师", access: { role: "架构师" as const, project: "Architect", roots: [] } };
  await op.createItem({ ...who, key: "made", title: "Made", accept: "ok", group: "Whitefoot" });
  await op.appendLog({ ...who, id: "other", text: "from the architect" });
  assert.ok(store.snapshot().items.made);
  assert.equal(store.snapshot().items.other!.log.at(-1)!.by, "Architect");
});

test("the texts that say who may do the process are built from one definition, and rx matches what it is given literally", () => {
  // The definition is pinned once, so that the expected texts built from it elsewhere cannot all agree on a typo.
  assert.equal(PROCESS_WRITERS, "PM with session PM or Architect with session 架构师");
  assert.equal(ARCHITECT_WRITER, "Architect with session 架构师");
  assert.ok(rx`only ${PROCESS_WRITERS} may`.test("author: only PM with session PM or Architect with session 架构师 may create items"));
  assert.ok(!rx`only ${PROCESS_WRITERS} may`.test("author: only Architect with session 架构师 may create items"), "the architect's session alone is another text");
  assert.ok(!rx`a${"."}b`.test("axb"), "an interpolated value matches literally");
});

const vocabulary = { 健全性: "改动影响程序是否被正确拒绝或接受", 报错信息: "改动影响诊断的措辞或位置" };
const outside = (id: string, root: string) => (e: unknown) => e instanceof OpError && new RegExp(`item ${id}: outside the subtree of ${root}`).test(e.message);

test("an engineer makes sub-items inside its subtree, rated and tagged, and cannot make a top item or pull in one from outside", async t => {
  const { op, store } = await board(t);
  for (const [name, meaning] of Object.entries(vocabulary)) await op.setTag({ ...asArchitect, name, meaning });
  const who = { author: "Whitefoot", session: "eng", access: engineer(["a"]) };
  const make = { title: "子条目", accept: "通过", tags: ["健全性"], difficulty: 2 as const };
  await op.createItem({ ...who, ...make, key: "sub", owner: "a" });
  const sub = store.snapshot().items.sub!;
  assert.deepEqual([sub.group, sub.difficulty, sub.tags], ["Whitefoot", 2, ["健全性"]], "it is in the engineer's project, rated and tagged");
  assert.deepEqual(sub.log.map(l => [l.by, l.text]), [["Whitefoot", "难度：未评 → 2，理由：建条目时评"]], "the rating is logged as the first rating, by the project");
  assert.ok(store.snapshot().items.a!.plan.some(row => "item" in row && row.item === "sub" && row.own), "the owner's plan owns it");
  // The subtree holds it from then on, at any depth.
  await op.appendLog({ ...who, id: "sub", text: "inside now" });
  await op.createItem({ ...who, ...make, key: "subsub", owner: "sub" });
  assert.equal(rules(store.snapshot()).parentOf("subsub"), "sub");
  const head = store.snapshot().head;
  // A top item is owned by no item of the subtree; an owner outside it, whether a sibling or another project's, is no owner.
  await assert.rejects(op.createItem({ ...who, ...make, key: "top", group: "Whitefoot" }), outside("top", "a"));
  await assert.rejects(op.createItem({ ...who, ...make, key: "n2", owner: "b" }), outside("b", "a"));
  await assert.rejects(op.createItem({ ...who, ...make, key: "n3", owner: "other" }), (e: unknown) => e instanceof OpError && /item other belongs to project Firn/.test(e.message));
  // Existing items moved into the new item's plan are written too, and so must be inside.
  await assert.rejects(op.createItem({ ...who, ...make, key: "n4", owner: "a", children: ["b"] }), (e: unknown) => e instanceof OpError && /outside the subtree of a/.test(e.message));
  assert.equal(store.snapshot().head, head, "no refused write was made");
  // The tag vocabulary still applies to an engineer, so a sub-item without a tag is refused.
  await assert.rejects(op.createItem({ ...who, title: "无标签", accept: "通过", key: "n5", owner: "a" }), (e: unknown) => e instanceof OpError && /tags: give at least one/.test(e.message));
});

test("an engineer rates and tags the items of its subtree and no others", async t => {
  const { op, store } = await board(t);
  for (const [name, meaning] of Object.entries(vocabulary)) await op.setTag({ ...asArchitect, name, meaning });
  const who = (roots: string[]) => ({ author: "Whitefoot", session: "eng", access: engineer(roots) });
  await op.setDifficulty({ ...who(["area"]), id: "a", difficulty: 3, reason: "涉及并发" });
  assert.deepEqual([store.snapshot().items.a!.difficulty, store.snapshot().items.a!.log.at(-1)!.text, store.snapshot().items.a!.log.at(-1)!.by], [3, "难度：2 → 3，理由：涉及并发", "Whitefoot"]);
  await op.setDifficultyMany({ ...who(["area"]), reason: "补评", items: [{ id: "a", difficulty: 4 }, { id: "b", difficulty: 1 }] });
  assert.deepEqual([store.snapshot().items.a!.difficulty, store.snapshot().items.b!.difficulty], [4, 1]);
  await op.setTags({ ...who(["area"]), id: "a", tags: ["健全性"] });
  await op.setTagsMany({ ...who(["area"]), items: [{ id: "a", tags: ["报错信息"] }, { id: "b", tags: ["健全性"] }] });
  assert.deepEqual([store.snapshot().items.a!.tags, store.snapshot().items.b!.tags], [["报错信息"], ["健全性"]]);
  // Outside the subtree: the sibling b of a for tags, an item of a tree of its own for ratings; one entry of a list refuses the whole list.
  await op.createItem({ ...asArchitect, key: "solo", title: "另一棵树", group: "Whitefoot", accept: "通过", tags: ["健全性"], difficulty: 2 });
  const head = store.snapshot().head;
  const calls: Array<[string, () => Promise<unknown>, string, string]> = [
    ["set_difficulty", () => op.setDifficulty({ ...who(["area"]), id: "solo", difficulty: 5, reason: "r" }), "solo", "area"],
    ["set_difficulty_many", () => op.setDifficultyMany({ ...who(["area"]), reason: "r", items: [{ id: "a", difficulty: 5 }, { id: "solo", difficulty: 5 }] }), "solo", "area"],
    ["set_tags", () => op.setTags({ ...who(["a"]), id: "b", tags: ["报错信息"] }), "b", "a"],
    ["set_tags_many", () => op.setTagsMany({ ...who(["a"]), items: [{ id: "a", tags: ["健全性"] }, { id: "b", tags: ["报错信息"] }] }), "b", "a"],
  ];
  for (const [name, call, id, root] of calls) await assert.rejects(call, outside(id, root), name);
  // Another project's item is refused as it is for any project author.
  await assert.rejects(op.setDifficulty({ ...who(["area"]), id: "other", difficulty: 2, reason: "r" }), (e: unknown) => e instanceof OpError && /item other belongs to project Firn/.test(e.message));
  await assert.rejects(op.setTags({ ...who(["area"]), id: "other", tags: ["健全性"] }), (e: unknown) => e instanceof OpError && /item other belongs to project Firn/.test(e.message));
  assert.equal(store.snapshot().head, head, "no refused write was made");
});

test("an engineer replies to the notes on its subtree and no others, and cannot close a note or rule a card", async t => {
  const { op, store } = await board(t);
  const who = (roots: string[]) => ({ author: "Whitefoot", session: "eng", access: engineer(roots) });
  // note-1 is the owner's comment on item a.
  await assert.rejects(op.replyNote({ ...who(["b"]), id: "note-1", reply: "不是我的" }), outside("a", "b"));
  assert.equal(store.snapshot().notes["note-1"]!.reply, undefined);
  // note-2 is on the card choice, which belongs to item b: a note on a card is in scope when the card's item is.
  await assert.rejects(op.replyNote({ ...who(["a"]), id: "note-2", reply: "x", replace: true }), outside("b", "a"));
  assert.equal(store.snapshot().notes["note-2"]!.reply, "中文回复");
  await op.replyNote({ ...who(["a"]), id: "note-1", reply: "改好了" });
  const note = store.snapshot().notes["note-1"]!;
  assert.deepEqual([note.state, note.reply, note.repliedBy], ["done", "改好了", "Whitefoot"]);
  await assert.rejects(op.closeNote({ ...who(["a"]), id: "note-2", log: "l" }), (e: unknown) => e instanceof OpError && /note\.close: a 工程师 credential may not write/.test(e.message));
  await assert.rejects(op.ruleCard({ ...who(["a"]), key: "choice", ruling: "r" }), (e: unknown) => e instanceof OpError && /card\.rule: a 工程师 credential may not write/.test(e.message));
});

test("an engineer cannot rate the item it was started on, only the items below it; tagging is not limited that way", async t => {
  const { op, store } = await board(t);
  for (const [name, meaning] of Object.entries(vocabulary)) await op.setTag({ ...asArchitect, name, meaning });
  const who = { author: "Whitefoot", session: "eng", access: engineer(["area"]) };
  const isRoot = (e: unknown) => e instanceof OpError && /item area: the root of this 工程师 credential/.test(e.message);
  const head = store.snapshot().head;
  await assert.rejects(op.setDifficulty({ ...who, id: "area", difficulty: 1, reason: "想降级" }), isRoot);
  await assert.rejects(op.setDifficultyMany({ ...who, reason: "r", items: [{ id: "a", difficulty: 5 }, { id: "area", difficulty: 1 }] }), isRoot);
  assert.equal(store.snapshot().head, head, "no refused write was made");
  assert.equal(store.snapshot().items.area!.difficulty, 2, "the level it was started at stays");
  // Below the root, at any depth, including a sub-item it has just made.
  await op.setDifficulty({ ...who, id: "a", difficulty: 5, reason: "r" });
  await op.createItem({ ...who, key: "sub", owner: "a", title: "子条目", accept: "通过", tags: ["健全性"], difficulty: 3 });
  await op.setDifficulty({ ...who, id: "sub", difficulty: 4, reason: "r" });
  assert.deepEqual(["a", "sub"].map(id => store.snapshot().items[id]!.difficulty), [5, 4]);
  // The tags of the root are the engineer's to write, as the rest of its head.
  await op.setTags({ ...who, id: "area", tags: ["健全性"] });
  assert.deepEqual(store.snapshot().items.area!.tags, ["健全性"]);
  // The architect rates any item, the root included.
  await op.setDifficulty({ ...asArchitect, id: "area", difficulty: 3, reason: "架构师改" });
  assert.equal(store.snapshot().items.area!.difficulty, 3);
});

test("a reply is replaced only by the author who wrote it, or by the PM or the architect", async t => {
  const { op, store } = await board(t);
  // note-1 is on item a and note-2 on the card choice, which belongs to item b: the engineer's subtree holds both.
  const engineerOf = (roots: string[]) => ({ author: "Whitefoot", session: "eng", access: engineer(roots) });
  const wrote = (id: string) => [store.snapshot().notes[id]!.reply, store.snapshot().notes[id]!.repliedBy];
  const notOwn = (by: string) => (e: unknown) => e instanceof OpError && new RegExp(`already replied by ${by} at .*replaced only by its author`).test(e.message);
  // The architect answered note-1; an engineer of the subtree may not overwrite that, with or without replace.
  await op.replyNote({ ...asArchitect, id: "note-1", reply: "架构师的回复" });
  await assert.rejects(op.replyNote({ ...engineerOf(["a", "b"]), id: "note-1", reply: "改掉", replace: true }), notOwn("Architect"));
  await assert.rejects(op.replyNote({ ...engineerOf(["a", "b"]), id: "note-1", reply: "改掉" }), notOwn("Architect"));
  // note-2 carries a reply by Whitefoot already: the same author is told how to replace their own reply.
  await assert.rejects(op.replyNote({ ...engineerOf(["a", "b"]), id: "note-2", reply: "再答" }), /already replied by Whitefoot at .*use replace: true/);
  assert.deepEqual(wrote("note-1"), ["架构师的回复", "Architect"]);
  // An engineer's own reply is replaced by the same project's author.
  await op.replyNote({ ...engineerOf(["a", "b"]), id: "note-2", reply: "更正", replace: true });
  assert.deepEqual(wrote("note-2"), ["更正", "Whitefoot"]);
  // Without a credential the same rule holds: the author is the project.
  await assert.rejects(op.replyNote({ author: "Whitefoot", id: "note-1", reply: "覆盖架构师", replace: true }), notOwn("Architect"));
  // The architect replaces any reply, but still only on purpose: without replace the reply stays.
  await assert.rejects(op.replyNote({ ...asArchitect, id: "note-2", reply: "没带 replace" }), /already replied by Whitefoot at .*use replace: true/);
  await op.replyNote({ ...asArchitect, id: "note-2", reply: "架构师改写", replace: true });
  assert.deepEqual(wrote("note-2"), ["架构师改写", "Architect"]);
  // The PM runs the process too: it replaces any reply, but only on purpose; a project author borrowing the PM's or the architect's session does not.
  await assert.rejects(op.replyNote({ ...asPM, id: "note-2", reply: "没带 replace" }), /already replied by Architect at .*use replace: true/);
  await op.replyNote({ ...asPM, id: "note-2", reply: "PM 改写", replace: true });
  assert.deepEqual(wrote("note-2"), ["PM 改写", "PM"]);
  for (const session of ["PM", "架构师"]) await assert.rejects(op.replyNote({ author: "Whitefoot", session, id: "note-2", reply: "冒名", replace: true }), notOwn("PM"));
  assert.deepEqual(wrote("note-2"), ["PM 改写", "PM"]);
  // Also a reply with no author recorded (an old one) and one by the retired coordinator, which nobody else can replace.
  const seed = async (id: string, repliedBy?: string) => {
    const note = store.snapshot().notes[id]!;
    await store.commit({ author: "Whitefoot", message: `seed ${id}`, puts: [{ kind: "note", id, expectRev: note.rev, doc: { ...note, reply: "旧回复", repliedAt: note.at, ...(repliedBy ? { repliedBy } : {}), state: "done" } }] });
  };
  for (const [id, by] of [["note-1", undefined], ["note-2", "总管"]] as const) {
    await seed(id, by);
    await assert.rejects(op.replyNote({ ...engineerOf(["a", "b"]), id, reply: "改", replace: true }), /already replied by .* at .*replaced only by its author/);
    for (const [who, name] of [[asArchitect, "Architect"], [asPM, "PM"]] as const) {
      await seed(id, by);
      await op.replyNote({ ...who, id, reply: "接手", replace: true });
      assert.deepEqual(wrote(id), ["接手", name]);
    }
  }
});
