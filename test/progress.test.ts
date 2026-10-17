import { test } from "node:test";
import assert from "node:assert/strict";
import { progressLine } from "../web/progress.ts";
import type { Progress } from "../src/rules.ts";

const names = { item: (id: string) => `item ${id}`, card: (key: string) => `card ${key}` };
const progress = (fields: Partial<Progress> = {}): Progress => ({ done: 2, total: 5, waiting: [], ask: false, behind: false, doing: [], sessions: [], ...fields });

test("a todo or part-done item reads how far it is and the first step ready to start", () => {
  assert.deepEqual(progressLine("partial", progress({ next: { id: "c", text: "Write the check" } }), names), { kind: "next", text: "做完 2/5，下一步：Write the check" });
  assert.equal(progressLine("todo", progress({ done: 0, next: { id: "a", text: "Start" } }), names)!.text, "做完 0/5，下一步：Start");
  assert.equal(progressLine("todo", progress({ done: 0 }), names)!.text, "做完 0/5", "no step ready to start: the ratio alone");
  assert.equal(progressLine("todo", progress({ done: 0, total: 0 }), names), undefined, "an item with no plan rows has nothing to say");
});

test("a blocked item names everything it waits on: the owner, the items and cards, and the rows ahead of it in its owner's plan", () => {
  const waiting = [{ kind: "item" as const, id: "dep" }, { kind: "card" as const, id: "q" }];
  assert.deepEqual(progressLine("blocked", progress({ waiting }), names), { kind: "blocked", text: "卡在：item dep；card q" });
  assert.equal(progressLine("blocked", progress({ ask: true }), names)!.text, "卡在：等主人");
  assert.equal(progressLine("blocked", progress({ behind: true }), names)!.text, "卡在：上级计划里排在它前面的行没做完");
  assert.equal(progressLine("blocked", progress({ ask: true, waiting: waiting.slice(0, 1), behind: true }), names)!.text, "卡在：等主人；item dep；上级计划里排在它前面的行没做完");
  assert.equal(progressLine("blocked", progress(), names)!.text, "卡在：计划里互相等待的行", "a cycle has no named cause");
});

test("a wip item names the sessions on it and the rows in progress, and each part may be missing", () => {
  const doing = [{ id: "w", text: "Write the parser" }, { id: "k", text: "Child item" }];
  assert.deepEqual(progressLine("wip", progress({ sessions: ["eng", "rev"], doing }), names), { kind: "doing", text: "eng、rev 在做：Write the parser；Child item" });
  assert.equal(progressLine("wip", progress({ doing: doing.slice(0, 1) }), names)!.text, "在做：Write the parser");
  assert.equal(progressLine("wip", progress({ sessions: ["eng"] }), names)!.text, "eng 在做");
});

test("paused, done, cancelled and record items show no line", () => {
  for (const status of ["paused", "done", "cancelled", undefined] as const) assert.equal(progressLine(status, progress({ next: { id: "a", text: "x" } }), names), undefined, String(status));
});
