// Temporary probe for the study n-writes-stable-study (not for merge): the press-n time while sessions write, alone and beside
// another browser test file. Run by the temporary workflow probe-writes.yml on the study branch only.

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


import { spawn } from "node:child_process";

/** The press-n check's own measure: busy time from the key until quiet, 30 landings, sessions writing 3 times a second. */
async function writingCell(browser: Browser, board: BoardServer, landingsWanted: number) {
  const { bp, cdp } = await openPage(browser, board);
  const w = startWriters(board, 3);
  const busy: number[] = [], land: number[] = [];
  for (let presses = 0; busy.length < landingsWanted && presses < 8 * landingsWanted; presses++) {
    const was = await bp.selected(), before = await busyTime(cdp);
    await bp.page.keyboard.press("n");
    await quiet(bp);
    const spent = await busyTime(cdp) - before, now = await bp.selected(), p = await take(bp);
    if (now === null || now === was) continue;
    const cur = p.curAt.filter(x => x >= p.pressAt);
    busy.push(spent); if (cur.length) land.push(Math.min(...cur) - p.pressAt);
  }
  await w.stop();
  await bp.context.close();
  return { busy: med(busy), busy90: q(busy, 0.9), land: med(land), land90: q(land, 0.9) };
}
/** Another browser test file running beside the measurement, as npm run test:e2e runs two files at a time. */
async function besideAnother<T>(fn: () => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, ["--test", "test/e2e/page.e2e.ts"], { stdio: "ignore", detached: true });
  await sleep(20_000);
  try { return await fn(); } finally { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } await sleep(2000); }
}

test("probe: the press-n time while writing, alone and beside another browser test file", { timeout: 60 * 60_000 }, async t => {
  const board = await startLiveBoard(t), browser = await launch(t);
  const base = process.env.PROBE_BASE!;
  const served = { base: await serveBoard(t, board, await pageOf(base)), twin: await serveBoard(t, board, await pageOf(base)), cand: await serveBoard(t, board, await pageOf(ROOT)) };
  type Name = "baseAlone" | "twinAlone" | "baseBeside" | "candAlone" | "candBeside";
  const cells: Record<Name, () => Promise<Awaited<ReturnType<typeof writingCell>>>> = {
    baseAlone: () => writingCell(browser, served.base, 30), twinAlone: () => writingCell(browser, served.twin, 30),
    baseBeside: () => besideAnother(() => writingCell(browser, served.base, 30)),
    candAlone: () => writingCell(browser, served.cand, 30), candBeside: () => besideAnother(() => writingCell(browser, served.cand, 30)),
  };
  const names = Object.keys(cells) as Name[], runs: Array<Record<Name, Awaited<ReturnType<typeof writingCell>>>> = [];
  const PAIRS = Number(process.env.PROBE_PAIRS ?? 6);
  for (let i = 0; i < PAIRS; i++) {
    const row = {} as Record<Name, Awaited<ReturnType<typeof writingCell>>>;
    const order = names.map((_, k) => names[(k + i) % names.length]!);
    for (const n of order) row[n] = await cells[n]();
    runs.push(row);
    out(`PAIR ${i} (${order.join(",")}): ` + names.map(n => `${n} busy ${f(row[n].busy)}/${f(row[n].busy90)} land ${f(row[n].land)}/${f(row[n].land90)}`).join(" | "));
  }
  for (const metric of ["busy", "busy90", "land", "land90"] as const) {
    const show = (n: Name) => { const iv = interval(runs.map(r => r[n][metric] / r.baseAlone[metric])); return `${n}/baseAlone ${iv.ratio.toFixed(3)} [${iv.lo.toFixed(3)}, ${iv.hi.toFixed(3)}]`; };
    out(`CELL ${metric}: medians ${names.map(n => n + " " + f(med(runs.map(r => r[n][metric])))).join(", ")}; ${(["twinAlone", "baseBeside", "candAlone", "candBeside"] as Name[]).map(show).join("; ")}`);
    out(`CELL ${metric} over limit (${metric.startsWith("busy") ? (metric === "busy" ? 200 : 300) : "-"}): ${names.map(n => n + " " + runs.filter(r => r[n][metric] > (metric === "busy" ? 200 : 300)).length + "/" + runs.length).join(", ")}`);
  }
});
