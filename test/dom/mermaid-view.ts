// What the two files of the diagram's box and toolbar share (test/dom/mermaid-view.test.ts: the size, the zoom and the drag;
// test/dom/mermaid-toolbar.test.ts: the 60%, 90% and 100% buttons, the toolbar and the signs that a diagram can be moved): the
// verdicts on a check's lines, the two diagrams a scene is seeded with, and a scene on one board with its page's errors.

import assert from "node:assert/strict";
import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { fence, FIT_HEAD, PIPELINE } from "../e2e/mermaid-charts.ts";
import { scene, setHead } from "./mermaid-checks.ts";
import type { Scene } from "./mermaid-checks.ts";

export const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.join("\n"));
/** The check must report a line that says `why`. */
export const caught = (v: string[], why: RegExp) => assert.ok(v.some(l => why.test(l)), `the check must report ${String(why)}; it reported:\n${v.join("\n") || "(nothing)"}`);

export const seedFit = (board: BoardServer, id: string) => setHead(board, id, FIT_HEAD);
export const seedPipeline = (board: BoardServer, id: string) => setHead(board, id, fence(PIPELINE));

/** On `board`: the violations of `run` on a scene of `seed` with `reverts`, and what the page reported. */
export function viewOn(board: BoardServer) {
  return async (st: Hooks, seed: (board: BoardServer, id: string) => Promise<void>, reverts: Revert[], run: (sc: Scene) => Promise<string[]>): Promise<string[]> => {
    const sc = await scene(st, board, seed, reverts);
    return [...await run(sc), ...sc.bp.errors.map(e => "page-error: " + e)];
  };
}
