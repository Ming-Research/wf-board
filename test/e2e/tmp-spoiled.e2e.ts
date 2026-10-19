// Temporary (agents-list-tidy): shows that the runner-table check of the browser file reports each of the things it guards, on pages with
// that thing spoiled. Deleted before the full CI; its output is recorded in the pull request.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, openAll, variantWeb } from "./harness.ts";
import type { Revert } from "./harness.ts";
import type { Hooks } from "./board-server.ts";
import { checkRunnerTable } from "./browser-checks.ts";

const cleanups: Array<() => unknown> = [];
const hooks: Hooks = { after: fn => { cleanups.push(fn); } };
after(async () => { for (const fn of cleanups.reverse()) await fn(); });
const html = (edit: string, find: string, replace: string): Revert => ({ file: "web/index.html", edit, find, replace });

const SPOILS: Array<{ name: string; reverts: Revert[]; reason: RegExp }> = [
  { name: "no cut: the ellipsis rule is gone", reverts: [html("no ellipsis", ".rt-what, .rt-total { overflow: hidden; text-overflow: ellipsis; }\n", "")], reason: /not cut with an ellipsis/ },
  { name: "rows grow with their text: no nowrap", reverts: [html("text wraps", "min-width: 0; white-space: nowrap; }\n.rt-what, .rt-total {", "min-width: 0; }\n.rt-what, .rt-total {")], reason: /not one line each of the same height/ },
  { name: "columns follow their content", reverts: [html("columns by content", "grid-template-columns: minmax(8rem, 3fr) 6.5rem minmax(0, 4fr) 5rem 12rem;", "grid-template-columns: auto auto auto auto auto;")], reason: /not in a column|lies outside its row/ },
  { name: "a narrow column does not fall to three lines", reverts: [html("no fold", "@container (max-width: 760px) {", "@container (max-width: 1px) {")], reason: /do not lie on three lines/ },
];

const browser = launch(hooks);
for (const spoil of SPOILS) {
  test(spoil.name, { timeout: 120_000 }, async () => {
    const board = await startBoard(hooks, { webDir: await variantWeb(hooks, spoil.reverts) });
    const bp = await BoardPage.open(await browser, board, openAll(board));
    const found = await checkRunnerTable(bp, board);
    console.log(`${spoil.name}:\n  ${found.join("\n  ")}`);
    assert.ok(found.some(line => spoil.reason.test(line)), `no violation matches ${spoil.reason}: ${found.join(" | ")}`);
  });
}
