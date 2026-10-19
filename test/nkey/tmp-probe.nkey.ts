// Temporary probe for nkey-lane-false-red: where the bias of the time layer comes from. Deleted before the branch is ready.
// Every window shows the current page (the slow one with 15 ms more per draw); each arm presses them in one order and the
// probe writes every press (arm, round, window, landing, predecessor, busy, gc time) to PROBE_OUT for analysis.

import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { PerformanceObserver, performance as perf } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Scope } from "./press.ts";
import { pageHtml, pageScript } from "../dom/page.ts";
import type { Press } from "./press.ts";
import { SLOW_DRAW, lap, log, startLane } from "./lane.ts";

setFlagsFromString("--expose-gc");
// A page meant to be about 2% slower: each draw takes PROBE_D2_MS more.
const D2_MS = Number(process.env.PROBE_D2_MS ?? 1.5);
const D2_DRAW = SLOW_DRAW.map(r => ({ ...r, edit: `a draw takes ${D2_MS} ms more`, replace: r.replace.replace("< 15", `< ${D2_MS}`) }));
const gc = runInNewContext("gc") as (o?: { type: "minor" | "major"; execution?: "sync" }) => void;

type Gc = { at: number; dur: number; kind: number };
const gcs: Gc[] = [];
new PerformanceObserver(list => { for (const e of list.getEntries()) gcs.push({ at: e.startTime, dur: e.duration, kind: (e as any).detail?.kind ?? 0 }); }).observe({ entryTypes: ["gc"] });

/** Round orders that repeat with a period: cyclic rotation (the lane's), or a cycle of n-1 rounds in which each window follows
 * each other window exactly once, the boundaries between rounds and the wrap from the last round to the first included. */
function orders(n: number, kind: string): number[][] {
  const ids = [...Array(n).keys()];
  if (kind === "cyclic") return ids.map(r => [...ids.slice(r), ...ids.slice(0, r)]);
  const seq: number[] = [], used = new Set<string>(), total = n * (n - 1);
  const step = (): boolean => {
    if (seq.length === total) return seq[total - 1] !== seq[0] && !used.has(`${seq[total - 1]}>${seq[0]}`);
    const inRound = seq.slice(seq.length - (seq.length % n));
    for (const x of ids) {
      if (inRound.includes(x)) continue;
      const key = seq.length ? `${seq[seq.length - 1]}>${x}` : "";
      if (key && (used.has(key) || seq[seq.length - 1] === x)) continue;
      seq.push(x); if (key) used.add(key);
      if (step()) return true;
      seq.pop(); if (key) used.delete(key);
    }
    return false;
  };
  if (!step()) throw new Error(`no balanced order for ${n} windows`);
  return Array.from({ length: n - 1 }, (_, r) => seq.slice(r * n, r * n + n));
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
    const m = /^(cyclic|balanced)(\d)(?:-(minor|major))?(-unique)?$/.exec(arm)!;
    const unique = !!m[4];
    const n = Number(m[2]), between = m[3];
    const labels = n === 5 ? ["base", "twin", "ctrl", "d2", "slow"] : n === 4 ? ["base", "twin", "ctrl", "slow"] : n === 3 ? ["base", "twin", "slow"] : ["base", "twin"];
    const scope = new Scope();
    try {
      const wins: Press[] = [];
      for (const label of labels) {
        const reverts = label === "slow" ? SLOW_DRAW : label === "d2" ? D2_DRAW : [];
        // unique: every window gets a source text of its own, so that no two windows share compiled code.
        const page = unique ? { script: (await pageScript(reverts)) + `\n// window ${label} round ${roundNo}\n`, html: await pageHtml(reverts) } : undefined;
        wins.push(await lane.open(scope, page ? { label, page } : { label, reverts }));
      }
      const order = orders(n, m[1]!);
      const was: Record<string, string | null> = Object.fromEntries(wins.map(w => [w.label, w.selected()]));
      const landed: Record<string, number> = Object.fromEntries(wins.map(w => [w.label, 0]));
      let prev = "none", gcCost = 0;
      for (let p = 0; landed.base! < WARM + PAIRS && p < 8 * (WARM + PAIRS); p++) {
        const got: Array<Record<string, unknown>> = [];
        for (const i of order[p % order.length]!) {
          const win = wins[i]!;
          if (between) { const g0 = perf.now(); gc({ type: between, execution: "sync" }); gcCost += perf.now() - g0; }
          const c0 = process.threadCpuUsage(), t0 = perf.now();
          const r = await win.press(writing ? lane.events[win.presses] : undefined);
          const t1 = perf.now(), c1 = process.threadCpuUsage(c0);
          got.push({ arm, job, round: roundNo, press: p, window: win.label, prev, busy: r.busy, cpu: (c1.user + c1.system) / 1000, t0, t1, landed: r.item !== null && r.item !== was[win.label] });
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
