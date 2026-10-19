// Temporary (nkey-lane-false-red): the acceptance runs of the time layer. Deleted before the branch is ready.
// ACCEPT_KIND=copy: the base page again in the changed page's place; slow6: a page whose press of n busy-waits a fixed time first, about
// 6% of the phase's base press (median of the base busy medians in the last acceptance run: 88 ms quiet, 95 ms writing). Each is one
// run of the time layer as the lane makes it for a changed page (a first red measured again), and its verdict is logged.

import { test } from "node:test";
import { PAIRS, WARMUP } from "./press.ts";
import type { PhaseWindow } from "./press.ts";
import { FLOOR, SLOW_DRAW, log, startLane, timeLayer } from "./lane.ts";
import { show } from "./stats.ts";
import type { Revert } from "../e2e/variant.ts";

const phase = process.env.ACCEPT_PHASE === "writing" ? "writing" : "quiet", kind = process.env.ACCEPT_KIND ?? "copy";
const EXTRA_MS = phase === "writing" ? 6 : 5;
const SLOW6: Revert[] = [{ file: "web/app.ts", edit: `a press of n takes ${EXTRA_MS} ms more`, find: 'run: () => { goNextFresh(); return true; }', replace: `run: () => { for (const began = performance.now(); performance.now() - began < ${EXTRA_MS};) {} goNextFresh(); return true; }` }];

test(`acceptance of the time layer: ${kind} ${phase}`, { timeout: 20 * 60_000 }, async t => {
  const lane = await startLane(t, { landings: WARMUP + PAIRS, writes: phase === "writing" });
  const windows: PhaseWindow[] = [
    { label: "base", open: s => lane.open(s, { label: "base" }) },
    { label: "twin", open: s => lane.open(s, { label: "twin" }) },
    { label: "cand", open: s => lane.open(s, kind === "slow6" ? { label: "cand", reverts: SLOW6 } : { label: "cand" }) },
    { label: "slow", open: s => lane.open(s, { label: "slow", reverts: SLOW_DRAW }) },
  ];
  const { result, violations } = await timeLayer(phase, windows, FLOOR[phase], true, phase === "writing" ? lane.events : undefined);
  const red = violations.some(v => v.includes("slower than its base in both runs"));
  const base = [...result.busy.base!].sort((a, b) => a - b)[Math.floor((result.busy.base!.length - 1) / 2)]!;
  if (kind === "slow6") log(`accept slow6 ${phase}: ${EXTRA_MS} ms more per press, ${(EXTRA_MS / base * 100).toFixed(1)}% of the base median ${base.toFixed(0)} ms; first run cand/ref ${show(result.ratios.cand!)}`);
  log(`accept ${kind} ${phase}: ${red ? "red" : "not red"}; violations: ${violations.length ? violations.join(" | ") : "none"}`);
});
