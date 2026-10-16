// The permission table (model ACCESS) and its enforcement in ops.run: what each role may write, and where.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCESS, PARTS, ROLES, writesAnyProject } from "../src/model.ts";
import type { Access, Part, Role } from "../src/model.ts";
import { OpError } from "../src/ops.ts";
import type { Ops } from "../src/ops.ts";
import { board, asArchitect } from "./helpers.ts";

const grants = (role: Role) => Object.entries(ACCESS[role]).map(([part, scope]) => `${part}:${scope}`).sort();
// What the design (docs/design.md, section 9) reserves for the architect, written out here and not read from the table.
const RESERVED: Part[] = ["project.create", "tag-vocab", "journal", "item.create", "item.title", "item.difficulty", "item.cancel", "item.pause", "item.move-project", "item.merge-row", "dispatch.start", "dispatch.finish"];

test("each role has the parts the design gives it", () => {
  assert.deepEqual(grants("审查"), ["item.log:subtree"]);
  assert.deepEqual(grants("工程师"), ["card.write:subtree", "item.head:subtree", "item.links:subtree", "item.log:subtree", "item.plan:subtree", "item.targets:subtree", "term:subtree"]);
  assert.deepEqual(grants("资源管理"), ["dispatch.finish:board", "item.head:subtree", "item.log:board", "item.plan:subtree"]);
  assert.deepEqual(grants("架构师"), PARTS.filter(p => p !== "item.merge-row").map(p => `${p}:board`).sort());
  assert.deepEqual(grants("观察者"), PARTS.filter(p => !RESERVED.includes(p)).map(p => `${p}:board`).sort());
  assert.deepEqual(ROLES.filter(writesAnyProject), ["架构师", "观察者", "资源管理"], "the engineer and the review write inside their own project only");
});

test("the writes the code reserves for the architect are the parts the table withholds from the observer", async t => {
  const { op } = await board(t);
  const legacy = { author: "Whitefoot", session: "someone" };
  const reserved: Array<[Part, () => Promise<unknown>]> = [
    ["item.create", () => op.createItem({ ...legacy, key: "n", title: "N", priority: "P1", accept: "ok", group: "Whitefoot" })],
    ["journal", () => op.journalEntry({ ...legacy, text: "x" })],
    ["item.difficulty", () => op.setDifficulty({ ...legacy, id: "a", difficulty: 2, reason: "r" })],
    ["tag-vocab", () => op.setTag({ ...legacy, name: "标签", meaning: "m" })],
    ["item.pause", () => op.setPause({ ...legacy, id: "a", paused: true, reason: "r" })],
    ["item.move-project", () => op.moveItemProject({ ...legacy, id: "a", project: "Firn" })],
    ["item.cancel", () => op.setStatus({ ...legacy, id: "a", status: "cancelled", log: "l" })],
    ["item.title", () => op.updateItem({ ...legacy, id: "a", rev: 1, title: "new title" })],
  ];
  for (const [part, call] of reserved) {
    await assert.rejects(call, (error: unknown) => error instanceof OpError && /only Architect/.test(error.message), `${part}: the code refuses an author that is not the architect`);
    assert.equal(ACCESS["观察者"][part], undefined, `${part}: and the observer's credential has no such part`);
    assert.ok(ACCESS["架构师"][part], `${part}: the architect's has`);
  }
});

// A call for every write, with the parts it changes. The arguments only have to be present: the table is asked before they are read.
const calls: Record<keyof Ops, Array<{ parts: Part[]; args: Record<string, unknown> }>> = {
  createProject: [{ parts: ["project.create"], args: { name: "N" } }],
  updateProject: [{ parts: ["project.update"], args: { name: "Whitefoot", repo: "o/r" } }],
  closeNote: [{ parts: ["note.close"], args: { id: "note-1", log: "l" } }],
  createItem: [{ parts: ["item.create"], args: { key: "n", title: "N", accept: "ok", priority: "P1", group: "Whitefoot" } }],
  appendLog: [{ parts: ["item.log"], args: { id: "a", text: "t" } }],
  markMerged: [{ parts: ["item.merge-row"], args: { id: "a", row: "r", merged: [], log: "l" } }],
  journalEntry: [{ parts: ["journal"], args: { text: "t" } }],
  dispatchStart: [{ parts: ["dispatch.start"], args: { id: "a", role: "工程师", level: 2, model: "m", agent: "g", agentId: "i" } }],
  dispatchFinish: [{ parts: ["dispatch.finish"], args: { id: "a", agentId: "i", result: "一次通过", usage: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }, cost: 1 } }],
  setPlan: [{ parts: ["item.plan"], args: { id: "a", remove: "r" } }],
  setTargets: [{ parts: ["item.targets"], args: { id: "a", remove: "r" } }],
  updateItem: [
    { parts: ["item.title"], args: { id: "a", rev: 1, title: "t" } }, { parts: ["item.head"], args: { id: "a", rev: 1, head: "h", reason: "r" } },
    { parts: ["item.links"], args: { id: "a", rev: 1, links: [] } }, { parts: ["item.priority"], args: { id: "a", rev: 1, priority: "P1" } },
    { parts: ["item.data"], args: { id: "a", rev: 1, data: "d" } }, { parts: ["item.order"], args: { id: "a", rev: 1, order: 1 } },
    { parts: ["item.record"], args: { id: "a", rev: 1, record: true } }, { parts: ["item.head", "item.links"], args: { id: "a", rev: 1, head: "h", reason: "r", links: [] } },
  ],
  setStatus: [{ parts: ["item.cancel"], args: { id: "a", status: "cancelled", log: "l" } }],
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
  writeCard: [{ parts: ["card.write"], args: { key: "k", item: "a", question: "q", background: "b", options: [{ key: "A", text: "t" }] } }],
  ruleCard: [{ parts: ["card.rule"], args: { key: "choice", ruling: "r" } }],
  replyNote: [{ parts: ["note.reply"], args: { id: "note-1", reply: "r" } }],
  setTerm: [{ parts: ["term"], args: { term: "词", definition: "d" } }],
  deleteTerm: [{ parts: ["term"], args: { term: "词" } }],
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
  const card = { key: "q-new", question: "q", background: "b", options: [{ key: "A", text: "t" }] };
  await op.writeCard({ ...who, ...card, item: "a" });
  assert.equal(store.snapshot().decisions["q-new"]!.item, "a");
  await assert.rejects(op.writeCard({ ...who, ...card, key: "q-other", item: "b" }), (e: unknown) => e instanceof OpError && /item b: outside the subtree/.test(e.message));
  // A move changes the owners of both items: it is not a part an engineer has.
  await assert.rejects(op.moveItem({ ...who, id: "a", owner: "b" }), (e: unknown) => e instanceof OpError && /item\.move: a 工程师 credential may not write/.test(e.message));
});

test("a subtree credential cannot change an item outside its subtree through the effect of its own write, nor take one into its subtree", async t => {
  const { op, store } = await board(t);
  const who = { author: "Whitefoot", session: "eng", access: engineer(["a"]) };
  // `other` is a root with a stored priority: a row of `a` that waits on it makes it a non-root, and the board then drops its
  // priority and logs that in `other` (a document of the Firn project, outside the subtree).
  const before = store.snapshot();
  assert.ok(before.items.other!.priority);
  await assert.rejects(op.setPlan({ ...who, id: "a", row: { item: "other", own: false } }), (e: unknown) => e instanceof OpError && /item other: outside the subtree of a/.test(e.message));
  assert.equal(store.snapshot().head, before.head, "nothing was written");
  assert.ok(store.snapshot().items.other!.priority, "and the other item kept its priority");
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
  await assert.rejects(op.createItem({ ...who, key: "n", title: "N", priority: "P1", accept: "ok", group: "Architect" }), (e: unknown) => e instanceof OpError && /item\.create: a 观察者 credential may not write/.test(e.message));
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

test("the architect's credential does what the architect does, in any project", async t => {
  const { op, store } = await board(t);
  const who = { author: "Architect", session: "架构师", access: { role: "架构师" as const, project: "Architect", roots: [] } };
  await op.createItem({ ...who, key: "made", title: "Made", priority: "P1", accept: "ok", group: "Whitefoot" });
  await op.appendLog({ ...who, id: "other", text: "from the architect" });
  assert.ok(store.snapshot().items.made);
  assert.equal(store.snapshot().items.other!.log.at(-1)!.by, "Architect");
});
