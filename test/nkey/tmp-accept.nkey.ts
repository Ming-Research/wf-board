// Temporary (nkey-lane-false-red): the acceptance runs of the time layer. Deleted before the branch is ready.
// ACCEPT_KIND=copy: the base page again in the changed page's place; slow25: a page whose draw takes 2.5 ms more there. Each is one run
// of the time layer as the lane makes it for a changed page (a first red measured again), and its verdict is logged.

import { test } from "node:test";
import { PAIRS, WARMUP } from "./press.ts";
import type { PhaseWindow } from "./press.ts";
import { FLOOR, SLOW_DRAW, log, startLane, timeLayer } from "./lane.ts";

const phase = process.env.ACCEPT_PHASE === "writing" ? "writing" : "quiet", kind = process.env.ACCEPT_KIND ?? "copy";
const SLOW25 = SLOW_DRAW.map(r => ({ ...r, edit: "a draw takes 2.5 ms more", replace: r.replace.replace("< 15", "< 2.5") }));

test(`acceptance of the time layer: ${kind} ${phase}`, { timeout: 20 * 60_000 }, async t => {
  const lane = await startLane(t, { landings: WARMUP + PAIRS, writes: phase === "writing" });
  const windows: PhaseWindow[] = [
    { label: "base", open: s => lane.open(s, { label: "base" }) },
    { label: "twin", open: s => lane.open(s, { label: "twin" }) },
    { label: "cand", open: s => lane.open(s, kind === "slow25" ? { label: "cand", reverts: SLOW25 } : { label: "cand" }) },
    { label: "slow", open: s => lane.open(s, { label: "slow", reverts: SLOW_DRAW }), versus: "cand" },
  ];
  const { violations } = await timeLayer(phase, windows, FLOOR[phase], true, phase === "writing" ? lane.events : undefined);
  const red = violations.some(v => v.includes("slower than its base in both runs"));
  log(`accept ${kind} ${phase}: ${red ? "red" : "not red"}; violations: ${violations.length ? violations.join(" | ") : "none"}`);
});
