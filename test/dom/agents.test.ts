// Three of the five scenarios of the agent list on the page, the other two in agents-fold.test.ts; each also runs on a page with one
// thing spoiled in agents-spoiled-*.test.ts (test/dom/agents-scenarios.ts holds the scenarios and the spoilings).

import { test } from "node:test";
import { listAboveProjects, twoSessions, cellUnfolds } from "./agents-scenarios.ts";

test("the agent list is above the projects, and 在树中 selects the item's tree row and Back returns", t => listAboveProjects(t));
test("two sessions on one item each show it, and the tree's element is still found once", t => twoSessions(t));
test("a cell unfolds its sub-items in place, the list folds apart from the tree, and every tree click still lands", t => cellUnfolds(t));
