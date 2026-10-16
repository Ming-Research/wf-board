import { test } from "node:test";
import assert from "node:assert/strict";
import { rules } from "../src/rules.ts";
import { planDifficultyMigration, applyDifficultyMigration, reportLines } from "../src/migrate-difficulty.ts";
import { board, author, at } from "./helpers.ts";

type Step = { id: string; text: string; state: "todo" | "doing" | "done" | "dropped"; accept?: true };
const step = (id: string, text: string, state: Step["state"] = "todo"): Step & Record<string, unknown> =>
  ({ id, text, state, ...(state === "done" ? { doneAt: at } : state === "doing" ? { since: at } : state === "dropped" ? { droppedAt: at, reason: "不做了" } : {}) });
const accept = (state: Step["state"] = "todo") => ({ ...step("accept", "验收通过", state), accept: true as const });

/** Writes work items with the given plan rows (an acceptance step is added) next to the board's fixture. */
async function seed(t: Parameters<typeof board>[0], items: Record<string, { rows: object[]; fields?: object }>) {
  const b = await board(t);
  await b.store.commit({ author: "Fixture", message: "Seed migration items", puts: Object.entries(items).map(([id, { rows, fields }]) => ({
    kind: "item" as const, id, expectRev: null, doc: { title: id, group: author, priority: "P2", plan: [...rows, accept()], updated: at, ...fields } })) });
  return b;
}

test("a row's 「（难度 N）」 or 「（架构师做）」 moves to the field, the marker leaves the row text, and nothing else changes", async t => {
  const { store } = await seed(t, {
    numbered: { rows: [step("study", "调研（难度 2）：找出慢的根", "doing"), step("impl", "实现（难度 2）：改掉它")] },
    ascii: { rows: [step("impl", "改掉它(难度 3)")] },
    mine: { rows: [step("discuss", "定下怎么改（架构师做）")] },
    plain: { rows: [step("impl", "没写难度的一行")] },
  });
  const s = store.snapshot(), plan = planDifficultyMigration(s);
  assert.deepEqual(plan.items.map(m => [m.id, m.difficulty]), [["ascii", 3], ["mine", "architect"], ["numbered", 2]]);
  assert.equal(plan.byHand.length, 0);
  const before = store.snapshot(), commits = (await store.log()).length;
  const commit = await applyDifficultyMigration(store, plan, "2026-10-16T00:00:00Z");
  assert.equal((await store.log()).length, commits + 1, "one commit for every item");
  assert.equal((await store.log({ limit: 1 }))[0]!.commit, commit);
  const after = store.snapshot();
  assert.equal(after.items.numbered!.difficulty, 2); assert.equal(after.items.ascii!.difficulty, 3); assert.equal(after.items.mine!.difficulty, "architect");
  assert.equal(after.items.plain!.difficulty, undefined, "an item that names no difficulty is left unrated");
  assert.deepEqual(after.items.numbered!.plan.map(row => "text" in row ? row.text : ""), ["调研：找出慢的根", "实现：改掉它", "验收通过"]);
  assert.equal(after.items.ascii!.plan[0] && "text" in after.items.ascii!.plan[0] ? after.items.ascii!.plan[0].text : "", "改掉它");
  const row = after.items.numbered!.plan[0]!;
  assert.deepEqual({ ...row, text: "" }, { ...before.items.numbered!.plan[0]!, text: "" }, "state, dates and ids of the row are kept");
  assert.deepEqual(after.items.plain, before.items.plain, "an untouched item is byte for byte the same");
  const logs = after.items.numbered!.log.slice(-2).map(l => l.text);
  assert.equal(logs[0], "难度：未评 → 2，理由：迁移：计划行文字里写的难度改存到字段", "the usual log line, from 未评");
  assert.match(logs[1]!, /^迁移：计划行里的难度标记已去掉：study「调研（难度 2）：找出慢的根」；impl「实现（难度 2）：改掉它」$/, "what was removed is kept in the log");
  assert.equal(rules(after).checks("numbered").filter(c => c.label === "缺难度").length, 0, "the migrated item no longer raises 缺难度");
  assert.equal(rules(after).checks("plain").filter(c => c.label === "缺难度").length, 1);
});

test("what a person must settle is reported and left alone: different levels, other wordings, nothing left to do", async t => {
  const { store } = await seed(t, {
    mixed: { rows: [step("a", "甲（难度 2）"), step("b", "乙（难度 1）")] },
    both: { rows: [step("a", "甲（难度 2）"), step("b", "乙（架构师做）")] },
    later: { rows: [step("a", "甲（难度按设计再评）")] },
    note: { rows: [step("a", "甲（难度 2，直接做）")] },
    spent: { rows: [step("a", "甲（难度 3）", "done"), step("b", "乙没写")] },
    empty: { rows: [step("a", "（难度 2）")] },
    clash: { rows: [step("a", "甲（难度 2）")], fields: { difficulty: 4 } },
    noted: { rows: [step("a", "走查（架构师做，含走查）")] },
    notedAscii: { rows: [step("a", "走查(架构师做:含走查)")] },
  });
  const before = store.snapshot(), plan = planDifficultyMigration(before);
  assert.deepEqual(plan.items, []);
  const byHand = Object.fromEntries(plan.byHand.map(h => [h.id, h.reason]));
  assert.match(byHand.mixed!, /不同的难度：2、1/);
  assert.match(byHand.both!, /不同的难度：2、architect/);
  assert.match(byHand.later!, /写法不在迁移认得的两种之内：（难度按设计再评）/);
  assert.match(byHand.note!, /写法不在迁移认得的两种之内：（难度 2，直接做）/);
  assert.match(byHand.spent!, /只有已完成或放弃的行写了难度/);
  assert.match(byHand.empty!, /空的/);
  assert.match(byHand.clash!, /字段已经是 4，行里写的是 2/);
  assert.match(byHand.noted!, /写法不在迁移认得的两种之内：（架构师做，含走查）/, "a noted 架构师做 is not guessed at");
  assert.match(byHand.notedAscii!, /写法不在迁移认得的两种之内：\(架构师做:含走查\)/);
  assert.equal(await applyDifficultyMigration(store, plan), undefined, "nothing planned, nothing committed");
  assert.deepEqual(store.snapshot(), before);
});

test("only unfinished rows decide the level, and the markers of finished rows go too", async t => {
  const { store } = await seed(t, { split: { rows: [step("design", "设计（难度 3）", "done"), step("impl", "实现（难度 2）")] } });
  const plan = planDifficultyMigration(store.snapshot());
  assert.deepEqual(plan.items.map(m => [m.id, m.difficulty, m.rows.map(row => row.id)]), [["split", 2, ["design", "impl"]]]);
  await applyDifficultyMigration(store, plan);
  assert.deepEqual(store.snapshot().items.split!.plan.map(row => "text" in row ? row.text : ""), ["设计", "实现", "验收通过"]);
});

test("closed items are left alone, an item already at the level only loses the marker, and a second run plans nothing", async t => {
  const { store, op } = await seed(t, {
    shipped: { rows: [step("impl", "实现（难度 2）", "done")] },
    set: { rows: [step("impl", "实现（难度 2）")], fields: { difficulty: 2 } },
    fresh: { rows: [step("impl", "实现（难度 1）")] },
  });
  await op.setPlan({ author, id: "shipped", row: { id: "accept", accept: true, text: "验收通过", state: "done" } });
  const plan = planDifficultyMigration(store.snapshot());
  assert.deepEqual(plan.closed, ["shipped"]);
  assert.deepEqual(plan.items.map(m => [m.id, m.alreadySet]), [["fresh", false], ["set", true]]);
  await applyDifficultyMigration(store, plan);
  const s = store.snapshot();
  assert.equal(s.items.set!.log.filter(l => l.text.startsWith("难度：")).length, 0, "no rating is logged where the field was already right");
  assert.equal(s.items.set!.log.at(-1)!.text.startsWith("迁移：计划行里的难度标记已去掉"), true);
  assert.equal("text" in s.items.shipped!.plan[0]! ? s.items.shipped!.plan[0]!.text : "", "实现（难度 2）", "a finished item's text stays");
  const again = planDifficultyMigration(s);
  assert.deepEqual([again.items.length, again.closed], [0, ["shipped"]], "the second run has nothing to migrate");
});

test("the report counts what stays unrated, which is what raises 缺难度 afterwards, and lists each item", async t => {
  const { store, op } = await seed(t, {
    marked: { rows: [step("impl", "实现（难度 2）")] },
    bare: { rows: [step("impl", "没写")] },
    paused: { rows: [step("impl", "没写")] },
  });
  await op.setPause({ author: "总管", id: "paused", paused: true, reason: "先放一放" });
  await op.createItem({ author, key: "pool", group: author, record: true, title: "待选池" });
  await op.createItem({ author, key: "pooled", owner: "pool", title: "待选里的", accept: "通过" });
  const plan = planDifficultyMigration(store.snapshot());
  assert.equal(plan.stillUnrated, 1, "marked is migrated, paused and backlog work is not needed, bare stays");
  const lines = reportLines(plan);
  assert.match(lines[0]!, /^migrate: 1, by hand: 0, rows that mention a difficulty but match no rule: 0, closed items left alone: 0, .*: 1$/);
  assert.ok(lines.includes("migrate marked [Whitefoot] 2"));
  assert.ok(lines.includes("    impl: 实现（难度 2）  →  实现"));
});

test("rows that mention a difficulty but match no rule are listed for open work, so a miss shows before --apply", async t => {
  const { store, op } = await seed(t, {
    bare: { rows: [step("a", "难度 2：实现"), step("b", "评估难度后再定"), step("c", "正常（难度 1）")] },
    plain: { rows: [step("a", "没提")] },
    shipped: { rows: [step("a", "架构师做：已经做完", "done")] },
  });
  await op.setPlan({ author, id: "shipped", row: { id: "accept", accept: true, text: "通过", state: "done" } });
  const plan = planDifficultyMigration(store.snapshot());
  assert.deepEqual(plan.unrecognised.map(u => [u.id, u.row, u.text]), [["bare", "a", "难度 2：实现"], ["bare", "b", "评估难度后再定"]], "a recognised marker is not listed, nor is a closed item's row");
  assert.deepEqual(plan.items.map(m => m.id), ["bare"], "the recognised row of the same item still migrates");
  const lines = reportLines(plan);
  assert.match(lines[0]!, /rows that mention a difficulty but match no rule: 2,/);
  assert.ok(lines.includes("unrecognised bare [Whitefoot] a: 难度 2：实现"));
});
