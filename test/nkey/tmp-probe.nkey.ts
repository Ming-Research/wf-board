// Temporary probe for nkey-lane-false-red: where the bias of the time layer comes from. Deleted before the branch is ready.
// Every window shows the current page (the slow one with 15 ms more per draw); each arm presses them in one order and the
// probe writes every press (arm, round, window, landing, predecessor, busy, gc time) to PROBE_OUT for analysis.

import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { PerformanceObserver, performance as perf } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Scope } from "./press.ts";
import type { Press } from "./press.ts";
import { SLOW_DRAW, lap, log, startLane } from "./lane.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as (o?: { type: "minor" | "major"; execution?: "sync" }) => void;

type Gc = { at: number; dur: number; kind: number };
const gcs: Gc[] = [];
new PerformanceObserver(list => { for (const e of list.getEntries()) gcs.push({ at: e.startTime, dur: e.duration, kind: (e as any).detail?.kind ?? 0 }); }).observe({ entryTypes: ["gc"] });

/** Round orders that repeat with a period: cyclic rotation (the lane's), or a cycle in which each window follows each other once. */
function orders(n: number, kind: string): number[][] {
  const ids = [...Array(n).keys()];
  if (kind === "cyclic") return ids.map(r => [...ids.slice(r), ...ids.slice(0, r)]);
  // balanced: search a cycle of n-1 permutations whose transitions (with the boundaries, cyclically) cover each ordered pair once.
  const perms: number[][] = [];
  const permute = (a: number[], k: number) => { if (k === a.length) { perms.push([...a]); return; } for (let i = k; i < a.length; i++) { [a[k], a[i]] = [a[i]!, a[k]!]; permute(a, k + 1); [a[k], a[i]] = [a[i]!, a[k]!]; } };
  permute([...ids], 0);
  const len = n - 1;
  const search = (chosen: number[][]): number[][] | undefined => {
    if (chosen.length === len) {
      const seq = chosen.flat(), seen = new Set<string>();
      for (let i = 0; i < seq.length; i++) { const key = `${seq[(i - 1 + seq.length) % seq.length]}>${seq[i]}`; if (seen.has(key)) return undefined; seen.add(key); }
      return chosen;
    }
    for (const p of perms) { const found = search([...chosen, p]); if (found) return found; }
    return undefined;
  };
  return search([])!;
}

test("probe: bias and noise of the time layer by press order", { timeout: 30 * 60_000 }, async t => {
  const writing = (process.env.PROBE_PHASE ?? "writing") === "writing";
  const PAIRS = Number(process.env.PROBE_PAIRS ?? 30), WARM = 2;
  const lane = await startLane(t, { landings: WARM + PAIRS, writes: writing });
  const arms = (process.env.PROBE_ARMS ?? "cyclic4,balanced4,cyclic3").split(",");
  const job = Number(process.env.PROBE_JOB ?? 0), roundsPerArm = Number(process.env.PROBE_ROUNDS ?? 2);
  // Arms in a rotating order by job and round, so no arm always runs first.
  const schedule: string[] = [];
  for (let r = 0; r < roundsPerArm; r++) for (let k = 0; k < arms.length; k++) schedule.push(arms[(k + job + r) % arms.length]!);
  const rows: unknown[] = [];
  let roundNo = 0;
  for (const arm of schedule) {
    roundNo++;
    const m = /^(cyclic|balanced)(\d)(?:-(minor|major))?$/.exec(arm)!;
    const n = Number(m[2]), between = m[3];
    const labels = n === 4 ? ["base", "twin", "ctrl", "slow"] : n === 3 ? ["base", "twin", "slow"] : ["base", "twin"];
    const scope = new Scope();
    try {
      const wins: Press[] = [];
      for (const label of labels) wins.push(await lane.open(scope, label === "slow" ? { label, reverts: SLOW_DRAW } : { label }));
      const order = orders(n, m[1]!);
      const was: Record<string, string | null> = Object.fromEntries(wins.map(w => [w.label, w.selected()]));
      const landed: Record<string, number> = Object.fromEntries(wins.map(w => [w.label, 0]));
      let prev = "none", gcCost = 0;
      for (let p = 0; landed.base! < WARM + PAIRS && p < 8 * (WARM + PAIRS); p++) {
        const got: Array<Record<string, unknown>> = [];
        for (const i of order[p % order.length]!) {
          const win = wins[i]!;
          if (between) { const g0 = perf.now(); gc({ type: between, execution: "sync" }); gcCost += perf.now() - g0; }
          const t0 = perf.now();
          const r = await win.press(writing ? lane.events[win.presses] : undefined);
          const t1 = perf.now();
          got.push({ arm, job, round: roundNo, press: p, window: win.label, prev, busy: r.busy, t0, t1, landed: r.item !== null && r.item !== was[win.label] });
          was[win.label] = r.item; prev = win.label;
        }
        if (got.every(g => g.landed)) { for (const g of got) { g.landing = landed.base; rows.push(g); } for (const w of wins) landed[w.label]!++; }
      }
      log(`probe: ${arm} round ${roundNo}: ${landed.base} landings${between ? `, ${gcCost.toFixed(0)} ms in forced gc` : ""}`);
    } finally { await scope.close(); }
    lap(`probe ${arm}`);
  }
  // The gc entries arrive after the press that held them: attributed by time once all are in.
  await new Promise(resolve => setTimeout(resolve, 200));
  for (const row of rows as Array<Record<string, number>>) {
    const inside = gcs.filter(g => g.at >= row.t0! && g.at <= row.t1!);
    row.gcMinor = inside.filter(g => g.kind === 1).reduce((a, g) => a + g.dur, 0);
    row.gcMajor = inside.filter(g => g.kind !== 1).reduce((a, g) => a + g.dur, 0);
  }
  if (process.env.PROBE_OUT) writeFileSync(process.env.PROBE_OUT, JSON.stringify(rows));
});
