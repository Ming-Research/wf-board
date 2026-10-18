// The blue bar of a changed body block and a changed card question, as the page's stylesheet states it: on the page as it is, where
// test/dom/style-checks.ts finds nothing, and on the page with one of the fixes that made it reversed, where it must report the bar.
// The page holds no changed block to look at, so the check adds probes to a window with the stylesheet and needs no page.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Revert } from "../e2e/variant.ts";
import { stylesheetWindow } from "./page.ts";
import { checkChangedBlocks } from "./style-checks.ts";

const BAR = '.rich > .chg-add::before, .card h3 > .chg-add::before { content: ""; position: absolute; left: -7px; top: 3px; bottom: 3px; width: 3px; border-radius: 2px; background: var(--fresh); }';
const css = (edit: string, find: string, replace: string): Revert => ({ file: "web/index.html", edit, find, replace });
const WITNESSES: Array<{ bug: string; reverts: Revert[] }> = [
  {
    bug: "changed body blocks lost their mark once the green background was removed (fixed in head-change-bar)",
    // The blue bar rule that marks a changed body block and a changed card question; removing it leaves both with no mark.
    reverts: [css("the blue bar of changed blocks", "\n" + BAR, "")],
  },
  {
    bug: "changed card questions lost their mark while changed body blocks kept theirs (fixed in head-change-bar)",
    // The bar rule without its card selector: the body block keeps its line, the card question loses it.
    reverts: [css("the card question's blue bar", ", .card h3 > .chg-add::before {", " {")],
  },
  {
    bug: "changed body blocks' blue bar lost its place beside the block (fixed in head-change-bar)",
    // Without absolute placement the bar falls into the block's flow, where it has no height and no place at the left.
    reverts: [css("the placement of the blue bar of changed blocks", '.rich > .chg-add::before, .card h3 > .chg-add::before { content: ""; position: absolute; ', '.rich > .chg-add::before, .card h3 > .chg-add::before { content: ""; ')],
  },
  {
    bug: "changed body blocks took a background colour (fixed in head-change-bar)",
    // A background on the changed block itself is the green mark the owner removed.
    reverts: [css("a background on changed blocks", ".rich > .chg-add { position: relative; display: flex; flex-direction: column; gap: 6px; }", ".rich > .chg-add { position: relative; display: flex; flex-direction: column; gap: 6px; background: #e3f2e6; }")],
  },
];

test("a changed block and a changed card question carry a blue bar at their left edge, and no background", async t => {
  const v = checkChangedBlocks(await stylesheetWindow(t));
  assert.equal(v.length, 0, v.length + " violations:\n" + v.join("\n"));
  for (const w of WITNESSES) await t.test(w.bug, async st => {
    const found = checkChangedBlocks(await stylesheetWindow(st, w.reverts));
    assert.ok(found.some(line => line.startsWith("changed-block")), `the check reports changed-block on the spoiled page, it reported ${JSON.stringify(found.slice(0, 2))}`);
  });
});
