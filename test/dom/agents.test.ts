// The five scenarios of the agent list on the page; each also runs on a page with one thing spoiled in agents-spoiled-*.test.ts
// (test/dom/agents-scenarios.ts holds the scenarios and the spoilings).

import { test } from "node:test";
import { listAboveProjects, twoSessions, cellUnfolds, othersFold, keyWithListUnfolded, slotsLine } from "./agents-scenarios.ts";

test("the agent list is above the projects, and 在树中 selects the item's tree row and Back returns", t => listAboveProjects(t));
test("two sessions on one item each show it, and the tree's element is still found once", t => twoSessions(t));
test("a cell unfolds its sub-items in place, the list folds apart from the tree, and every tree click still lands", t => cellUnfolds(t));
test("a session with no dispatch record sits behind 其他 N 个 until the line is opened, and a running one is unfolded above it", t => othersFold(t));
test("with a cell of the list unfolded and nothing selected, c asks for a row of the tree", t => keyWithListUnfolded(t));
test("the runner's free slots stand under the heading, open or folded, marked once a pool has had nothing to start for an hour", t => slotsLine(t));
