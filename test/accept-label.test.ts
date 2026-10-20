import { test } from "node:test";
import assert from "node:assert/strict";
import { board, asArchitect } from "./helpers.ts";
import { rules } from "../src/rules.ts";
import { mergeRows } from "../src/watch.ts";

// The page puts its 验收 tag in front of every acceptance step, so a text that starts with the label is stored without it.
test("an acceptance step whose text starts with the 验收 label is stored without it; other steps keep theirs", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "label", group: "Whitefoot", title: "Label", head: "**问题**：x", accept: "[验收] 线上部署后能看到" });
  assert.deepEqual(store.snapshot().items.label!.plan.map(r => "text" in r ? r.text : ""), ["线上部署后能看到"], "create_item strips the label");
  await op.setPlan({ ...asArchitect, id: "label", rows: [
    { id: "impl", text: "[验收] 不是验收的一步", state: "todo" },
    { id: "acc", accept: true, text: "[验收]  带空格的验收", state: "todo" },
    // Nothing is left after the label: the step keeps its text, so it never has an empty one.
    { id: "bare", accept: true, text: "[验收]", state: "todo" },
  ] });
  assert.deepEqual(store.snapshot().items.label!.plan.map(r => "text" in r ? r.text : ""), ["[验收] 不是验收的一步", "带空格的验收", "[验收]"], "set_plan strips it from acceptance steps only");
});

// A merge row is done only when a pull request it names merges and 改动 names it too: a row naming none of its pull requests in 改动 never gets done.
test("a merge row naming pull requests that 改动 does not name is flagged until 改动 names one of them", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "ship", group: "Whitefoot", title: "Ship it", head: "**问题**：x\n\n## 改动\n\n- 改了 a.ts", accept: "验收通过" });
  await op.setPlan({ ...asArchitect, id: "ship", rows: [
    { id: "merge", text: "合入 Ming-Research/Whitefoot#74", state: "todo" },
    { id: "acc", accept: true, text: "验收通过", state: "todo" },
  ] });
  const flags = () => rules(store.snapshot()).checks("ship").filter(c => c.id === "merge-pr-unlisted");
  assert.equal(flags().length, 1, "#74 is not in 改动: the row can never be marked done");
  assert.match(flags()[0]!.text, /Ming-Research\/Whitefoot#74/, "the flag names the pull request to add");
  assert.deepEqual(mergeRows(store.snapshot(), rules(store.snapshot())).filter(m => m.item === "ship").map(m => m.prs.length), [], "no counted pull request, so no merge row");
  await op.updateItem({ ...asArchitect, id: "ship", rev: store.snapshot().items.ship!.rev, head: "**问题**：x\n\n## 改动\n\nMing-Research/Whitefoot#74：改了 a.ts", reason: "name the pull request" });
  assert.equal(flags().length, 0, "once 改动 names it, the flag goes");
  assert.deepEqual(mergeRows(store.snapshot(), rules(store.snapshot())).filter(m => m.item === "ship").map(m => m.prs.map(p => p.number)), [[74]], "the merge row counts #74 again");
});
