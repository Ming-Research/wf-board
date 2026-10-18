// What one press of n costs in a real browser, on a board of the live board's weight (test/e2e/live-board.ts), reported and never judged.
// The owner wants the page to answer within 0.2 s (board-read-fast). What holds that against a change is the draws and rebuilds a press
// makes and the paired timing in a DOM library (test/nkey), which run on every pull request; the time in a real browser depends on the
// runner (a hosted runner's speed differs by up to a factor of two between jobs), so here it is a number to read over the days:
// the main thread's busy time from the key until the page is quiet, over 30 landings, with the board quiet. It goes to the log and to the
// job summary; the test fails only when n does not reach 30 other items, which means the measurement is empty.
// Run by CI's `browser` workflow (npm run test:press-n-report), not on the owner's Mac.

import { test } from "node:test";
import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";
import type { CDPSession } from "playwright";
import { launch, BoardPage } from "./harness.ts";
import { startLiveBoard } from "./live-board.ts";

const LANDINGS = 30, MEDIAN_MS = 200, P90_MS = 300;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
const p90 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(0.9 * xs.length))]!;
const ms = (x: number) => x.toFixed(0);

// The page redoes its rules when a minute passes, and that rebuild would fall into whichever press it meets, so the page's minute tick is held still.
const HOLD_MINUTE_TICK = `(() => { const every = window.setInterval.bind(window); window.setInterval = (fn, delay, ...rest) => delay >= 30000 ? 0 : every(fn, delay, ...rest); })();`;

async function busyTime(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find(m => m.name === "TaskDuration")!.value * 1000;
}

test("one press of n on a board of the live board's weight, in a real browser: the main thread's busy time", { timeout: 15 * 60_000 }, async t => {
  const board = await startLiveBoard(t), browser = await launch(t);
  const bp = await BoardPage.open(browser, board, {}, HOLD_MINUTE_TICK);
  const cdp = await bp.context.newCDPSession(bp.page);
  await cdp.send("Performance.enable");
  await bp.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  const busy: number[] = [];
  // A press inside the item shown does not count; n lands on another item or the press is made again.
  for (let presses = 0; busy.length < LANDINGS && presses < 8 * LANDINGS; presses++) {
    const was = await bp.selected(), before = await busyTime(cdp);
    await bp.page.keyboard.press("n");
    // The quiet stretch after the draws is idle time, not busy time.
    await bp.settle(); await sleep(120); await bp.settle();
    const took = await busyTime(cdp) - before;
    if ((await bp.selected()) !== was) busy.push(took);
  }
  assert.equal(busy.length, LANDINGS, `n reached ${LANDINGS} other items`);
  const line = `press-n in a real browser, board quiet (reported, not judged): ${busy.length} landings, main-thread busy ms median ${ms(median(busy))} (the old limit ${MEDIAN_MS}), 90th percentile ${ms(p90(busy))} (${P90_MS}), max ${ms(Math.max(...busy))}`;
  console.log(line);
  console.log(busy.map(ms).join(" "));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
});
