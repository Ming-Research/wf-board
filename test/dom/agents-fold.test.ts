// Two of the five scenarios of the agent list on the page, the other three in agents.test.ts; each also runs on a page with one
// thing spoiled in agents-spoiled-*.test.ts (test/dom/agents-scenarios.ts holds the scenarios and the spoilings).

import { test } from "node:test";
import { othersFold, keyWithListUnfolded } from "./agents-scenarios.ts";

test("a session with no dispatch record sits behind 其他 N 个 until the line is opened, and a running one is unfolded above it", t => othersFold(t));
test("with a cell of the list unfolded and nothing selected, c asks for a row of the tree", t => keyWithListUnfolded(t));
