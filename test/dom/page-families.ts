// The owner's page in a DOM library against the real server, on a generated board with the real board's shapes. Every kind of
// clickable thing must land on what it claims: first on a freshly loaded page per family, then on one page kept open while
// sessions write elsewhere between the families, so incremental re-renders happen in between. The browser layer keeps what
// needs a layout (test/e2e/browser.e2e.ts); the checks are in test/dom/checks.ts. The families run in several files
// (page-*.test.ts), each with a board and a page of its own, so the files run side by side.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, openAll } from "../e2e/board-server.ts";
import type { BoardServer } from "../e2e/board-server.ts";
import { DomPage } from "./page.ts";
import { oracle, burst, checkTreeRows, checkRows, checkPlanRows, checkDependents, checkBadges, checkWaitPanel, checkFresh, checkWrap, checkFilters, checkSearch, checkComments, checkThreads, checkEmptyRows, checkTagText, checkCardBox, checkDifficultyChip, checkIdleStatus } from "./checks.ts";
import type { Oracle } from "./checks.ts";

const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.slice(0, 60).join("\n"));
/** The violations of a family and what the page reported while it ran (an error thrown in a handler is a violation too). */
async function run(bp: DomPage, family: () => Promise<string[]>): Promise<string[]> {
  bp.errors = [];
  const v = await family();
  return [...v, ...bp.errors.map(e => "page-error: " + e)];
}

/** The families, by the key a file asks for them with. With `projects`, the project filters are checked for the projects at the
 * positions k with k % of === part only. */
function families(bp: DomPage, board: BoardServer, projects?: Share): Record<string, [string, (o: Oracle) => Promise<string[]>]> {
  const w = board.gen.witness;
  // Items whose plans name cards (every one), share other items, or own items (a sample); items with dependents.
  const planItems = (o: Oracle) => {
    const ids = Object.keys(o.s.items), plan = (id: string) => o.s.items[id]!.plan;
    return [...new Set([
      ...ids.filter(id => plan(id).some(row => "card" in row)),
      ...ids.filter(id => plan(id).some(row => "item" in row && !row.own)).slice(0, 20),
      ...ids.filter(id => plan(id).some(row => "item" in row && row.own)).slice(0, 8),
    ])];
  };
  // The witness cards (one of every shape) and a sample of the rest.
  const cardSample = (o: Oracle) => [...new Set([w.commentCard, w.multiPlanCard, w.donePlanCard, w.otherPlanCard, w.rowCard, w.recordCard, w.legacyCard, w.proseCard, w.withdrawnCard, w.openLegacyCard, ...Object.keys(o.s.decisions).slice(0, 30)])].filter(c => o.s.decisions[c]);
  const depItems = (o: Oracle) => Object.keys(o.s.items).filter(id => o.r.dependents(id).some(d => !d.own)).slice(0, 25);
  return {
    tree: ["tree rows select their item", o => checkTreeRows(bp, o)],
    plan: ["plan rows: items go there, cards go to the card in the body, steps select", o => checkPlanRows(bp, o, planItems(o))],
    cards: ["decision cards show question, option names and details, confidence or a one-line pick, folded old background, and sit where the head puts them or follow it with a note", o => checkCardBox(bp, o, cardSample(o))],
    dependents: ["dependent rows go to their item and Back returns", o => checkDependents(bp, o, depItems(o))],
    badges: ["purple and red numbers count and reach their own waits", o => checkBadges(bp, o)],
    waits: ["header wait numbers and the wait panel", o => checkWaitPanel(bp, o)],
    fresh: ["blue numbers, the 新 number and n", o => checkFresh(bp, o)],
    filters: ["project filters count, show and hide the right items" + (projects ? ` (part ${projects.part + 1} of ${projects.of}: the projects at positions ${projects.part}, ${projects.part + projects.of}, ...)` : ""),
      o => checkFilters(bp, o, o.s.board.projects.map(p => p.name).filter((_, k) => !projects || k % projects.of === projects.part))],
    search: ["search finds and shows items and cards", o => checkSearch(bp, o)],
    wrap: ["n and the arrows wrap around the list from its bottom row and from the cursor", o => checkWrap(bp, o)],
    rows: ["the tree draws the rows the rules call for, closed items holding unread content included, after writes to them", () => checkRows(bp, board)],
  };
}

/** The part `part` (from 0) of `of` of a list, dealt out by position: the elements at positions k with k % of === part. */
export interface Share { part: number; of: number }
/** Which of the two passes a file runs: the families each on a freshly loaded page, and again on a page kept open while writes land;
 * `projects` shares the project filters out over files, and a file asks for its part. */
export interface PageRun { chips?: boolean; passes?: Array<"fresh" | "after">; projects?: Share }

/** One test file's share of the page's checks: the families `keys`, each on a freshly loaded page and then on a page kept open
 * while a burst of writes lands elsewhere before it; with `chips`, also the small checks of tags, rows and comments. Each file has
 * a board of its own, and a file stays within the time one hosted-runner job gives a test file (docs/design.md, section 11). */
export function pageTests(title: string, keys: string[], { chips = false, passes = ["fresh", "after"], projects }: PageRun = {}) {
  test(title, { timeout: 5 * 60_000 }, async t => {
    const board = await startBoard(t), w = board.gen.witness;
    const bp = await DomPage.open(t, board, { storage: openAll(board) });
    const all = families(bp, board, projects), order = Object.keys(all);
    const picked = keys.map(k => ({ round: order.indexOf(k) + 1, name: all[k]?.[0] ?? assert.fail("no family " + k), family: all[k]![1] })).sort((a, b) => a.round - b.round);
    if (passes.includes("fresh")) for (const { name, family } of picked) await t.test("fresh page: " + name, async () => {
      await bp.reset(openAll(board));
      none(await run(bp, async () => family(await oracle(board.store))));
    });
    // One page stays open. A family sees the writes of its place in the full order: before it the bursts of the families ahead of it
    // have landed (only the bursts are replayed for a family that is not here), so the page has applied as many incremental updates
    // as when all the families ran in one file.
    if (passes.includes("after")) {
      await bp.reset(openAll(board));
      let landed = 0;
      for (const { round, name, family } of picked) await t.test("after writes elsewhere: " + name, async () => {
        const base = bp.changes();
        let n = 0;
        while (landed < round) n += await burst(board, ++landed);
        await bp.waitChanges(base + n);
        none(await run(bp, async () => family(await oracle(board.store))));
      });
    }
    if (!chips) return;
    await t.test("no empty row under an item's title", async () => {
      await bp.reset(openAll(board));
      const o = await oracle(board.store), ids = Object.keys(o.s.items), st = (id: string) => o.r.statusOf(id);
      const sample = [w.unpaused, w.pausedRoot, w.code, ...o.r.children(w.pausedRoot).slice(0, 1), ids.find(id => o.s.items[id]!.record), ids.find(id => st(id) === "done"),
        ids.find(id => st(id) === "cancelled"), ids.find(id => st(id) === "blocked"), ids.find(id => o.r.askPending(id))].filter((id): id is string => !!id);
      none(await run(bp, () => checkEmptyRows(bp, [...new Set(sample)])));
    });
    await t.test("tag chips name the item's tags", async () => {
      await bp.reset(openAll(board));
      await bp.select(w.unpaused);
      none(await run(bp, async () => checkTagText(bp, await oracle(board.store))));
    });
    await t.test("the difficulty chip says the item's difficulty in the line of tags, and an unrated item has none", async () => {
      await bp.reset(openAll(board));
      none(await run(bp, async () => checkDifficultyChip(bp, await oracle(board.store))));
    });
    await t.test("part-done items read 停滞: their chip, their box and their project's filter", async () => {
      await bp.reset(openAll(board));
      none(await run(bp, async () => checkIdleStatus(bp, await oracle(board.store))));
    });
    await t.test("a comment saved on a folded list stays in view and its 发送 sends it", async () => {
      await bp.reset({ ...openAll(board), "board-notes": { ["it:" + w.commentItem]: false, ["q:" + w.commentCard]: false } });
      none(await run(bp, async () => checkComments(bp, await oracle(board.store))));
    });
    await t.test("a comment that follows another is listed under it and the composer opens there", async () => {
      await bp.reset({ ...openAll(board), "board-notes": { ["it:" + w.commentItem]: true } });
      none(await run(bp, () => checkThreads(bp)));
    });
  });
}
