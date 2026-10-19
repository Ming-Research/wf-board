// `update_item` with `sections` and `replace` (docs/design.md, section 6, Changing things): one commit, the revision up by
// one, the rest of the item as it was, and a call with an edit that does not fit writes nothing. How the edits are located and
// shown is test/head-edit.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpError } from "../src/ops.ts";
import { board, author } from "./helpers.ts";

const HEAD = [
  "背景一句。",
  "",
  "**问题**：甲很长。乙也很长。",
  "",
  "**为什么**：因为丙。",
  "",
  "**做法**：",
  "- 先做 X。",
  "- 再做 Y。",
  "",
].join("\n");

/** The fixture's item a with HEAD, and a write on its current revision with a reason. */
async function seeded(t: Parameters<typeof board>[0]) {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.updateItem({ author, id: "a", rev: store.snapshot().items.a!.rev, head: HEAD, reason: "Seed the head" });
  const write = (args: Record<string, unknown>) => op.updateItem({ author, id: "a", rev: store.snapshot().items.a!.rev, reason: "Edit parts", ...args } as Parameters<typeof op.updateItem>[0]);
  return { store, op, write };
}

test("parts of a head are written in one commit: the rev goes up by one, one log line is added, and only those parts change", async t => {
  const { store, op } = await seeded(t);
  const before = store.snapshot().items.a!;
  const done = await op.updateItem({ author, id: "a", rev: before.rev, reason: "Reword two parts", sections: [{ title: "做法", text: "**做法**：\n- 只做 Z。" }], replace: [{ old: "因为丙", new: "因为戊" }, { old: "乙也很长。", new: "" }] });
  const after = store.snapshot().items.a!;
  assert.equal(after.rev, before.rev + 1);
  assert.equal(after.head, HEAD.replace("因为丙", "因为戊").replace("乙也很长。", "").replace("- 先做 X。\n- 再做 Y。", "- 只做 Z。"));
  assert.deepEqual(after.log.slice(0, -1), before.log); assert.equal(after.log.at(-1)!.text, "改了 head：Reword two parts");
  assert.deepEqual({ ...after, head: 0, rev: 0, updated: 0, log: 0 }, { ...before, head: 0, rev: 0, updated: 0, log: 0 }, "nothing else changed");
  // The answer carries the lines that changed, for the writer to check without reading the head back.
  const lines = (done.changes ?? "").split("\n");
  assert.match(lines[0]!, /^head changed in 3 places; /);
  for (const line of ["  - **为什么**：因为丙。", "  + **为什么**：因为戊。", "  - - 先做 X。", "  + - 只做 Z。", "  + **问题**：甲很长。"]) assert.ok(lines.includes(line), `${line} in ${done.changes}`);
});

test("a call with an edit that does not fit writes nothing, and says which one and why", async t => {
  const { store, write } = await seeded(t);
  const before = store.snapshot();
  for (const [args, message] of [
    [{ replace: [{ old: "因为丙", new: "x" }, { old: "不在正文里", new: "y" }] }, /replace\[1\]\.old: "不在正文里" occurs 0 times/],
    [{ replace: [{ old: "。", new: "x" }] }, /replace\[0\]\.old: "。" occurs \d+ times/],
    [{ sections: [{ title: "没有这一节", text: "**没有这一节**：x" }] }, /sections\[0\]\.title: no section is titled/],
    [{ sections: [{ title: "为什么", text: "**为什么**：x" }], replace: [{ old: "因为丙", new: "y" }] }, /change the same text/],
    [{ head: "整段", replace: [{ old: "因为丙", new: "y" }] }, /head: give either the whole head, or sections and replace/],
    [{ replace: [{ old: "因为丙", new: "y" }], reason: undefined }, /reason: explain why head changed/],
    [{ replace: [{ old: "因为丙", new: "  … 12 more characters (section \"问题\")" }] }, /holds the line "… 12 more characters \(section "问题"\)".*context section: "all"/],
    [{ replace: [{ old: " ", new: "y" }] }, /input\.replace\.0\.old: provide nonempty text after trimming/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    await assert.rejects(write(args), (error: unknown) => error instanceof OpError && message.test(error.message), String(message));
    assert.deepEqual(store.snapshot(), before, `${message}: the board is as it was`);
  }
});

test("a replacement may be empty, and deletes what it replaces", async t => {
  const { store, write } = await seeded(t);
  await write({ replace: [{ old: "背景一句。\n\n", new: "" }] });
  assert.ok(store.snapshot().items.a!.head!.startsWith("**问题**："));
});

test("parts of a head on a revision that is behind stand when the head has not changed since, and are refused when it has", async t => {
  const { store, op, write } = await seeded(t);
  const read = store.snapshot().items.a!.rev;
  await op.appendLog({ author, id: "a", text: "A log line meanwhile" });
  const done = await op.updateItem({ author, id: "a", rev: read, reason: "Edit on a behind rev", replace: [{ old: "因为丙", new: "因为戊" }] });
  assert.match(done.note ?? "", /^rev \d+ was behind \(current rev \d+\): .+ since, and head did not change, so the edit was written$/);
  assert.match(done.changes ?? "", /因为戊/);
  assert.ok(store.snapshot().items.a!.log.some(entry => entry.text === "A log line meanwhile"), "the log line is kept");
  // Another writer changed the head since the revision that was read: refused, though the text to replace is still there once.
  const current = store.snapshot().items.a!.rev;
  await write({ replace: [{ old: "甲很长", new: "甲变了" }] });
  const head = store.snapshot().items.a!.head;
  await assert.rejects(op.updateItem({ author, id: "a", rev: current, reason: "Stale", replace: [{ old: "因为戊", new: "因为己" }] }), /rev \d+: current rev \d+; .*head changed.*redo.*rev \d+/);
  assert.equal(store.snapshot().items.a!.head, head);
});

test("parts of a head are a head write for a credential", async t => {
  const { op, store } = await seeded(t);
  const review = { author: "Whitefoot", session: "rev", access: { role: "审查" as const, project: "Whitefoot", roots: ["a"] } };
  const rev = store.snapshot().items.a!.rev;
  for (const args of [{ sections: [{ title: "为什么", text: "**为什么**：x" }] }, { replace: [{ old: "因为丙", new: "y" }] }]) {
    await assert.rejects(op.updateItem({ ...review, id: "a", rev, reason: "r", ...args }), (e: unknown) => e instanceof OpError && /item\.head: a 审查 credential may not write/.test(e.message));
  }
  assert.equal(store.snapshot().items.a!.rev, rev);
});
