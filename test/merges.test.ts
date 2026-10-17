// Which item delivered a merge (src/merges.ts): the pull request a commit subject names, the item whose 改动 section names it,
// and whom to tell when several do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asArchitect, author, board } from "./helpers.ts";
import { deliveries, pullNumbers, tellFirst } from "../src/merges.ts";

test("a merge commit and a squash commit name their pull request; anything else names none", () => {
  assert.deepEqual(pullNumbers("Merge pull request #7 from Ming-Research/branch"), [7]);
  assert.deepEqual(pullNumbers("Show the unread count (#12)"), [12]);
  assert.deepEqual(pullNumbers("Show the unread count (#12) "), [12]);
  assert.deepEqual(pullNumbers("Fix #12 in the list"), [], "a bare number is not a merge");
  assert.deepEqual(pullNumbers("Merge branch 'main' into feature (#3) again"), [], "the squash form ends the subject");
  assert.deepEqual(pullNumbers("Merge pull request #x from y"), []);
  assert.deepEqual(pullNumbers(""), []);
});

test("the items delivering the pulls the subjects name are those whose 改动 section names them, and a held one is told first", async t => {
  const { store, op } = await board(t);
  const section = (item: string, text: string) => {
    const doc = store.snapshot().items[item]!;
    return store.commit({ author, message: "name pull requests", puts: [{ kind: "item", id: item, expectRev: doc.rev, doc: { ...doc, head: `${doc.head}\n\n**改动**\n\n${text}` } }] });
  };
  await section("a", "Ming-Research/Whitefoot#1");
  await section("other", "Ming-Research/Whitefoot#1 Ming-Research/Whitefoot#2");
  const s = () => store.snapshot();
  assert.deepEqual(deliveries(s(), "Ming-Research/Whitefoot", ["Merge pull request #1 from x"]), [{ pr: 1, item: "other" }, { pr: 1, item: "a" }], "every item that names it, in the board's item order");
  assert.deepEqual(deliveries(s(), "Ming-Research/Whitefoot", ["B (#2)", "Merge pull request #1 from x", "again (#2)"]).map(d => d.pr), [2, 1, 1], "a pull request once, in the order the subjects name them");
  assert.deepEqual(deliveries(s(), "Ming-Research/Whitefoot", ["Merge pull request #9 from x", "no number"]), [], "no item names it");
  assert.deepEqual(deliveries(s(), "Other/Repo", ["Merge pull request #1 from x"]), [], "another repository's pull request 1 is not this one");
  // Nobody holds either: the first is the one to name in a push to the PM.
  const all = deliveries(s(), "Ming-Research/Whitefoot", ["Merge pull request #1 from x"]);
  assert.deepEqual(tellFirst(s(), all), [{ pr: 1, item: "other" }]);
  await op.dispatchStart({ ...asArchitect, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "a-worker", agentId: "agent-a" });
  assert.deepEqual(tellFirst(s(), all), [{ pr: 1, item: "a" }], "the one a session holds, though it comes second");
  assert.deepEqual(tellFirst(s(), []), []);
});
