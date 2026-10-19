// A standing item on the page in a DOM library: the 「常设」 tag after its title in the tree and in the detail, no count of its plan's
// rows done, and the ∞ row of a standing item it owns. The rules are tested on plain data in test/standing.test.ts; the tag's look is
// the browser file's. docs/design.md, section 5, Item plans, Standing items; section 7.

import { test } from "node:test";
import assert from "node:assert/strict";
import { boardTags, tagApplies } from "../../src/model.ts";
import { startBoard } from "../e2e/board-server.ts";
import { DomPage } from "./page.ts";

const architect = { author: "Architect", session: "架构师" };

test("a standing item shows the 常设 tag in the tree and the detail and no count of rows done, and the standing item under it a ∞ row", async t => {
  const board = await startBoard(t), bp = await DomPage.open(t, board);
  const s = board.store.snapshot(), group = s.items[board.gen.witness.unpaused]!.group;
  // Tags are required of a new item when the vocabulary offers its project one.
  const tag = boardTags(s.board).find(x => tagApplies(x, group)), tags = tag ? { tags: [tag.name] } : {};
  const make = (key: string, extra: Record<string, unknown> = {}) => board.ops.createItem({ ...architect, key, group, title: key, accept: `${key} holds`, ...tags, ...extra } as Parameters<typeof board.ops.createItem>[0]);
  await make("std-top");
  await make("std-block", { owner: "std-top", after: [] });
  await bp.waitFor(() => bp.head("std-top") !== null, "the new top item in the tree");
  await bp.select("std-top");
  const treeHead = () => bp.head("std-top")!, detail = () => bp.$("#item-detail > .item")!;
  const detailHead = () => bp.$(":scope > .item-row > .item-head", detail())!;
  // The control: ordinary work has no tag and shows how many of its rows are done.
  assert.equal(bp.$(".standing-tag", treeHead()), null);
  assert.ok(bp.$(".steps-ratio", treeHead()), "an ordinary item with no row done shows its count in the tree");
  assert.ok(bp.$(".plan > .log-head > .steps-ratio", detail()), "and in the detail's plan heading");

  const rev = (id: string) => board.store.snapshot().items[id]!.rev;
  const base = bp.changes();
  await board.ops.updateItem({ ...architect, id: "std-top", rev: rev("std-top"), standing: true });
  await board.ops.updateItem({ ...architect, id: "std-block", rev: rev("std-block"), standing: true });
  await bp.waitChanges(base + 2);
  await bp.waitFor(() => bp.$(".standing-tag", treeHead()) !== null && bp.$(".standing-tag", detailHead()) !== null, "the tag on the tree row and the detail");
  assert.equal(bp.$(".standing-tag", treeHead())!.textContent, "常设");
  assert.equal(bp.$(".standing-tag", detailHead())!.textContent, "常设");
  assert.match(bp.$(".standing-tag", treeHead())!.title, /一直进行中，不会完成/);
  assert.equal(bp.$(".steps-ratio", treeHead()), null, "a standing item has no count of rows done in the tree");
  assert.equal(bp.$(".plan > .log-head > .steps-ratio", detail()), null, "nor in the plan heading of the detail");
  assert.equal(bp.$(".st", treeHead())!.textContent, bp.$(".st", detailHead())!.textContent, "the status chip of the two heads is the same");
  // The row for the standing item it owns is resolved and drawn ∞ in the colour of a paused row.
  const rows = bp.$$(".plan-row.item-line", detail());
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.classList.contains("standing"), "the row's class says standing");
  assert.equal(bp.$(":scope > .g", rows[0]!)!.textContent, "∞");
  assert.deepEqual(bp.errors, []);
});
