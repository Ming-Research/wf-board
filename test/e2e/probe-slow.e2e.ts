// Temporary probe for the study n-writes-stable-study (not for merge): base, twin and candidate pages at the runner's speed and
// with the page's CPU throttled, as a slower runner would run it. Run by the temporary workflow probe-writes.yml on the study branch only.

import { test } from "node:test";
import { writeFile, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { rules, reuseStats } from "../../src/rules.ts";
import type { Rules } from "../../src/rules.ts";
import type { Item, Snapshot } from "../../src/model.ts";
import type { Browser, CDPSession } from "playwright";
import { prng } from "./board-gen.ts";
import { launch, BoardPage, serveBoard, ROOT } from "./harness.ts";
import type { BoardServer } from "./harness.ts";
import { startLiveBoard } from "./live-board.ts";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN; };
const f = (x: number) => Number.isFinite(x) ? x.toFixed(0) : "-";
const out = (line: string) => console.log(line);
const PROFILE_SECONDS = Number(process.env.PROBE_PROFILE_SECONDS ?? 20), LANDINGS = Number(process.env.PROBE_LANDINGS ?? 30);

const INIT = `(() => {
  const p = window.__probe = { pressAt: 0, curAt: [], draws: [], rules: [], changes: [], keys: [] };
  addEventListener("keydown", () => { p.pressAt = performance.now(); }, true);
  const after = fn => { const ch = new MessageChannel(); ch.port1.onmessage = fn; ch.port2.postMessage(0); };
  const mark0 = performance.mark.bind(performance);
  performance.mark = (name, opts) => {
    const t = performance.now();
    if (name === "board:render") { const d = [t, 0, opts && opts.detail]; p.draws.push(d); after(() => { d[1] = performance.now(); }); }
    else if (name === "board:rules") p.rules.push(t);
    return mark0(name, opts);
  };
  const Source = window.EventSource;
  window.EventSource = class extends Source {
    addEventListener(type, fn, ...rest) {
      if (type !== "change") return super.addEventListener(type, fn, ...rest);
      return super.addEventListener(type, ev => { const t = performance.now(); try { return fn(ev); } finally { const c = [t, performance.now() - t, 0]; p.changes.push(c); after(() => { c[2] = performance.now() - t; }); } }, ...rest);
    }
  };
  new MutationObserver(list => { for (const m of list) if (m.target.classList && m.target.classList.contains("cur") && !(m.oldValue || "").split(" ").includes("cur")) p.curAt.push(performance.now()); })
    .observe(document, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  new PerformanceObserver(list => { for (const e of list.getEntries()) if (e.name === "keydown") p.keys.push([e.startTime, e.processingStart - e.startTime, e.processingEnd - e.processingStart, e.duration]); })
    .observe({ type: "event", durationThreshold: 16, buffered: true });
  const every = window.setInterval.bind(window);
  window.setInterval = (fn, delay, ...rest) => delay >= 30000 ? 0 : every(fn, delay, ...rest);
  window.__takeProbe = () => { const s = JSON.parse(JSON.stringify(p)); p.curAt = []; p.draws = []; p.rules = []; p.changes = []; p.keys = []; return s; };
})();`;
interface Probe { pressAt: number; curAt: number[]; draws: Array<[number, number, string]>; rules: number[]; changes: Array<[number, number, number]>; keys: Array<[number, number, number, number]> }
const take = (bp: BoardPage) => bp.page.evaluate(() => (window as unknown as { __takeProbe(): Probe }).__takeProbe());

async function busyTime(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find(m => m.name === "TaskDuration")!.value * 1000;
}
async function quiet(bp: BoardPage) { await bp.settle(); await sleep(120); await bp.settle(); }
async function openPage(browser: Browser, board: BoardServer) {
  const bp = await BoardPage.open(browser, board, {}, INIT);
  const cdp = await bp.context.newCDPSession(bp.page);
  await cdp.send("Performance.enable");
  await bp.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await take(bp);
  return { bp, cdp };
}
function startWriters(board: BoardServer, perSecond: number) {
  const rnd = prng(777);
  let stopped = false, count = 0;
  const ids = Object.keys(board.store.snapshot().items).filter(id => !board.store.snapshot().items[id]!.record);
  const loop = (async () => {
    while (!stopped) {
      const id = rnd.pick(ids), it = board.store.snapshot().items[id]!, { rev, ...doc } = it, at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      try { await board.store.commit({ author: it.group, message: "writer", puts: [{ kind: "item", id, expectRev: rev, doc: { ...doc, log: [...it.log, { at, by: it.group, text: "持续写入。" }], updated: at } }] }); count++; } catch { /* lost race */ }
      await sleep(1000 / perSecond);
    }
  })();
  return { stop: async () => { stopped = true; await loop; return count; } };
}

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface CpuProfile { nodes: Node[]; samples: number[]; timeDeltas: number[] }
function summarize(label: string, profile: CpuProfile, per: number, unit: string) {
  const byId = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const key = (n: Node) => { const fr = n.callFrame; return (fr.functionName || "(anonymous)") + (fr.url ? " " + fr.url.split("/").pop() + ":" + (fr.lineNumber + 1) : ""); };
  const stacks = new Map<number, string[]>();
  const stackOf = (id: number): string[] => { let s = stacks.get(id); if (s) return s; const p = parent.get(id); s = [...(p === undefined ? [] : stackOf(p)), key(byId.get(id)!)]; stacks.set(id, s); return s; };
  const self = new Map<string, number>(), incl = new Map<string, number>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000, st = stackOf(id), leaf = st[st.length - 1]!;
    if (leaf.startsWith("(idle)") || leaf.startsWith("(program)")) return;
    total += dt;
    self.set(leaf, (self.get(leaf) ?? 0) + dt);
    for (const k of new Set(st)) incl.set(k, (incl.get(k) ?? 0) + dt);
  });
  const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${(v / per).toFixed(1).padStart(7)} ms/${unit}  ${k}`).join("\n");
  out(`PROFILE ${label}: ${per} ${unit}s, ${(total / per).toFixed(1)} ms/${unit} sampled outside idle (profiler overhead included)`);
  out(`-- inclusive\n${top(incl, 70)}`);
  out(`-- self\n${top(self, 30)}`);
}


async function pageOf(root: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "probe-page-"));
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "index.html"), await readFile(join(root, "web/index.html")));
  await symlink(join(ROOT, "web/dist/mermaid.js"), join(dir, "dist/mermaid.js"));
  await build({ entryPoints: [join(root, "web/app.ts")], bundle: true, format: "esm", target: "es2022", outfile: join(dir, "dist/app.js"), logLevel: "silent" });
  return dir;
}

/** Mean of the log ratios and its 95% interval (t distribution), as ratios. */
function interval(ratios: number[]) {
  const T = [12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09];
  const l = ratios.map(Math.log), n = l.length, m = l.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(l.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)), h = (T[n - 2] ?? 2.0) * sd / Math.sqrt(n);
  return { ratio: Math.exp(m), lo: Math.exp(m - h), hi: Math.exp(m + h), half: (Math.exp(h) - 1) };
}



type Cell = { perWrite: number; wBusy: number; wBusy90: number; qBusy: number; qBusy90: number; wLand: number; wLand90: number; filterMismatches: number };
async function landingsBusy(bp: BoardPage, cdp: CDPSession, wanted: number) {
  const busy: number[] = [], land: number[] = [];
  for (let presses = 0; busy.length < wanted && presses < 8 * wanted; presses++) {
    const was = await bp.selected(), before = await busyTime(cdp);
    await bp.page.keyboard.press("n");
    await quiet(bp);
    const spent = await busyTime(cdp) - before, now = await bp.selected(), p = await take(bp);
    if (now === null || now === was) continue;
    busy.push(spent);
    const cur = p.curAt.filter(x => x >= p.pressAt); if (cur.length) land.push(Math.min(...cur) - p.pressAt);
  }
  return Object.assign(busy, { land });
}
async function slowCell(browser: Browser, board: BoardServer, rate: number): Promise<Cell> {
  // Quiet landings on a page of their own, as the press-n check makes them.
  const quietPage = await openPage(browser, board);
  await quietPage.cdp.send("Emulation.setCPUThrottlingRate", { rate });
  const q30 = await landingsBusy(quietPage.bp, quietPage.cdp, 30);
  await quietPage.bp.context.close();
  const { bp, cdp } = await openPage(browser, board);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  const c0 = await bp.changes(), b0 = await busyTime(cdp);
  const w = startWriters(board, 3); await sleep(6000); await w.stop(); await quiet(bp);
  const perWrite = (await busyTime(cdp) - b0) / Math.max(1, await bp.changes() - c0);
  const w2 = startWriters(board, 3);
  const w30 = await landingsBusy(bp, cdp, 30);
  await w2.stop(); await quiet(bp);
  const filterMismatches = await bp.page.evaluate(() => { const f = (window as unknown as { __checkFilterCounts?: () => number }).__checkFilterCounts; return f ? f() : -1; });
  await bp.context.close();
  return { perWrite, wBusy: med(w30), wBusy90: q(w30, 0.9), qBusy: med(q30), qBusy90: q(q30, 0.9), wLand: med(w30.land), wLand90: q(w30.land, 0.9), filterMismatches };
}

test("probe: base, twin and candidate pages at the runner's speed and throttled twice", { timeout: 80 * 60_000 }, async t => {
  const board = await startLiveBoard(t), browser = await launch(t);
  const base = process.env.PROBE_BASE!;
  const served = { base: await serveBoard(t, board, await pageOf(base)), twin: await serveBoard(t, board, await pageOf(base)), cand: await serveBoard(t, board, await pageOf(ROOT)) };
  const variants = ["base", "twin", "cand"] as const, rates = (process.env.PROBE_RATES ?? "1,2").split(",").map(Number);
  const PAIRS = Number(process.env.PROBE_PAIRS ?? 4);
  const runs: Array<Record<string, Cell>> = [];
  for (let i = 0; i < PAIRS; i++) {
    const row: Record<string, Cell> = {};
    const names = rates.flatMap(rate => variants.map(v => [v, rate] as const));
    for (let k = 0; k < names.length; k++) { const [v, rate] = names[(k + i) % names.length]!; row[v + "@" + rate] = await slowCell(browser, served[v], rate); }
    runs.push(row);
    out(`PAIR ${i}: ` + Object.entries(row).map(([n, c]) => `${n} perWrite ${f(c.perWrite)} writing ${f(c.wBusy)}/${f(c.wBusy90)} land ${f(c.wLand)}/${f(c.wLand90)} quiet ${f(c.qBusy)}/${f(c.qBusy90)}${c.filterMismatches >= 0 ? " filterMismatches " + c.filterMismatches : ""}`).join(" | "));
  }
  for (const rate of rates) for (const metric of ["perWrite", "wBusy", "wBusy90", "wLand", "wLand90", "qBusy", "qBusy90"] as const) {
    const at = (v: string) => runs.map(r => r[v + "@" + rate]![metric]);
    const twin = interval(runs.map(r => r["twin@" + rate]![metric] / r["base@" + rate]![metric])), cand = interval(runs.map(r => r["cand@" + rate]![metric] / r["base@" + rate]![metric]));
    const limit = metric === "wBusy" || metric === "qBusy" || metric === "wLand" ? 200 : metric === "perWrite" ? Infinity : 300;
    out(`CELL rate ${rate} ${metric}: base ${at("base").map(f).join(" ")}, twin ${at("twin").map(f).join(" ")}, cand ${at("cand").map(f).join(" ")}; twin/base ${twin.ratio.toFixed(3)} [${twin.lo.toFixed(3)}, ${twin.hi.toFixed(3)}] noise ±${(twin.half * 100).toFixed(1)}%; cand/base ${cand.ratio.toFixed(3)} [${cand.lo.toFixed(3)}, ${cand.hi.toFixed(3)}]` + (Number.isFinite(limit) ? `; over ${limit}: base ${at("base").filter(x => x > limit).length}, cand ${at("cand").filter(x => x > limit).length} of ${runs.length}` : ""));
  }
  // Where the candidate's write still goes, at the runner's speed.
  {
    const { bp, cdp } = await openPage(browser, served.cand);
    const warm = startWriters(board, 3); await sleep(3000); await warm.stop(); await quiet(bp);
    await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    const c0 = await bp.changes();
    await cdp.send("Profiler.start");
    const w = startWriters(board, 3); await sleep(20_000); await w.stop(); await quiet(bp);
    const { profile } = await cdp.send("Profiler.stop") as { profile: CpuProfile };
    summarize("candidate page, sessions writing 3/s", profile, await bp.changes() - c0, "write");
    await bp.context.close();
  }
});
