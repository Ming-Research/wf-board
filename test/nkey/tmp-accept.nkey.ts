// Temporary (nkey-lane-false-red): the acceptance runs of the time layer. Deleted before the branch is ready.
// ACCEPT_KIND=copy: the base page again in the changed page's place, ACCEPT_ROUNDS single rounds, each round's ratio logged for pooling.
// ACCEPT_KIND=slow25: a page whose draw takes 2.5 ms more in the changed page's place, judged as the lane judges a changed page.

import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { PAIRS, WARMUP, timePhase } from "./press.ts";
import type { PhaseWindow } from "./press.ts";
import { FLOOR, SLOW_DRAW, lap, log, startLane } from "./lane.ts";
import { compare, show } from "./stats.ts";

const phase = process.env.ACCEPT_PHASE === "writing" ? "writing" : "quiet", kind = process.env.ACCEPT_KIND ?? "copy";
const rounds = Number(process.env.ACCEPT_ROUNDS ?? 1);
const SLOW25 = SLOW_DRAW.map(r => ({ ...r, edit: "a draw takes 2.5 ms more", replace: r.replace.replace("< 15", "< 2.5") }));

test(`acceptance of the time layer: ${kind} ${phase}`, { timeout: 20 * 60_000 }, async t => {
  const lane = await startLane(t, { landings: WARMUP + PAIRS, writes: phase === "writing" });
  const windows: PhaseWindow[] = [
    { label: "base", open: s => lane.open(s, { label: "base" }) },
    { label: "twin", open: s => lane.open(s, { label: "twin" }) },
    { label: "cand", open: s => lane.open(s, kind === "slow25" ? { label: "cand", reverts: SLOW25 } : { label: "cand" }) },
    { label: "slow", open: s => lane.open(s, { label: "slow", reverts: SLOW_DRAW }), versus: "cand" },
  ];
  // A copy is measured one round at a time, so that each round's ratio stands alone; the slow page is judged as the lane judges.
  if (kind === "copy") process.env.NKEY_FLOOR = "1";
  const dump: unknown[] = [];
  for (let k = 0; k < rounds; k++) {
    const r = await timePhase(windows, FLOOR[phase], phase === "writing" ? lane.events : undefined);
    const ratio = compare(r.busy.cand!, r.busy.base!);
    log(`accept ${kind} ${phase} run ${k + 1}: cand/base ${show(ratio)} log ${Math.log(ratio.ratio).toFixed(5)} rounds ${r.rounds} verdict ${r.verdicts.cand} twin ${show(r.ratios.twin!)}`);
    lap(`accept run ${k + 1}`);
    // Every landing of the round with what the page marked, for the analysis of a window that reads slower than its twin.
    for (const [label, list] of Object.entries(r.first)) list.forEach((l, i) => dump.push({ run: k, label, i, opened: r.opening.indexOf(label), busy: l.busy, draws: l.draws, rules: l.rules, full: l.full, structure: l.structure, stops: l.stops, freshStops: l.freshStops, filters: l.filters, innerHtml: l.innerHtml, created: l.created, scopes: l.scopes, item: l.item }));
  }
  if (process.env.ACCEPT_OUT) writeFileSync(process.env.ACCEPT_OUT, JSON.stringify(dump));
});
