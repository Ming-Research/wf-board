// What the two files of the owner's page with a mermaid block share (test/dom/mermaid-page.test.ts, the drawing, the library and its
// settings; test/dom/mermaid-redraw.test.ts, the drawing again after an update, the ids, the diagram's own settings, the view and
// the colors): the seeds of a scene, and a scene on one board with the page's errors added to what the check says. The verdicts on a
// check's lines are test/dom/mermaid-view.ts's.

import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { fence, GOOD, HEAD, OWN, PIPELINE } from "../e2e/mermaid-charts.ts";
import { scene, setHead, addLog } from "./mermaid-checks.ts";
import type { Scene } from "./mermaid-checks.ts";

export const seedHead = (board: BoardServer, id: string) => setHead(board, id, HEAD);
export const seedLog = (board: BoardServer, id: string) => addLog(board, id, "日志里的图：\n\n" + fence(GOOD));
export const seedOne = (board: BoardServer, id: string) => setHead(board, id, fence(GOOD));
// The first copy sits in the head's 参考 section, which is folded; the second is in the log, opened after the first is drawn.
export const seedTwice = async (board: BoardServer, id: string) => { await setHead(board, id, "正文。\n\n**参考：同一张图**\n" + fence(GOOD)); await addLog(board, id, "同一张图又画一次：\n\n" + fence(GOOD)); };
export const seedOwn = (board: BoardServer, id: string) => setHead(board, id, fence(OWN));
export const seedPipeline = (board: BoardServer, id: string) => setHead(board, id, fence(PIPELINE));
export const seedNone = (board: BoardServer, id: string) => setHead(board, id, "没有图，只有代码：\n\n```wf\nfn main() {}\n```");

/** The scenes of one board: `on` gives the violations of `run` on a scene of `seed` with `reverts` on the witness item, or on the
 * spare item `own`, and what the page reported. */
export function scenesOn(board: BoardServer) {
  // The scenes that write a log entry use an item of their own each, so no diagram of an earlier scene is in a later one's log.
  const items = Object.entries(board.store.snapshot().items).filter(([id, it]) => !it.record && id !== board.gen.witness.code).map(([id]) => id);
  const spare = (n: number) => items[n]!;
  async function on(st: Hooks, seed: (board: BoardServer, id: string) => Promise<void>, reverts: Revert[], run: (sc: Scene) => Promise<string[]>, own?: number): Promise<string[]> {
    const sc = await scene(st, board, seed, reverts, 600, own === undefined ? undefined : spare(own));
    return [...await run(sc), ...sc.bp.errors.map(e => "page-error: " + e)];
  }
  return on;
}
