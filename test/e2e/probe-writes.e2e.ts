// Temporary probe for the study n-writes-stable-study (not for merge): what a session's write costs the page, and what the
// press-n time while sessions write is made of. Run by the temporary workflow probe-writes.yml on the study branch only.

import { test } from "node:test";
import { writeFile, mkdir } from "node:fs/promises";
import type { Browser, CDPSession } from "playwright";
import { prng } from "./board-gen.ts";
import { launch, BoardPage } from "./harness.ts";
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

test("probe: a write's cost on the page and the parts of press-n time while writing", { timeout: 40 * 60_000 }, async t => {
  const board = await startLiveBoard(t), browser = await launch(t);
  await mkdir("probe-out", { recursive: true });

  // 1. No key pressed, sessions writing 3 times a second: the page's main thread per write, and where it goes.
  {
    const { bp, cdp } = await openPage(browser, board);
    const warm = startWriters(board, 3); await sleep(4000); await warm.stop(); await quiet(bp); await take(bp);
    await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    const b0 = await busyTime(cdp);
    await cdp.send("Profiler.start");
    const w = startWriters(board, 3); await sleep(PROFILE_SECONDS * 1000); const written = await w.stop(); await quiet(bp);
    const { profile } = await cdp.send("Profiler.stop") as { profile: CpuProfile };
    const busy = await busyTime(cdp) - b0, p = await take(bp);
    await writeFile("probe-out/writes.cpuprofile", JSON.stringify(profile));
    const handler = p.changes.map(c => c[1]), task = p.changes.map(c => c[2]), draws = p.draws.map(d => d[1] - d[0]);
    out(`WRITES idle page: ${written} writes, ${p.changes.length} change events, busy ${f(busy)} ms = ${(busy / p.changes.length).toFixed(1)} ms per change event (profiler on); rules builds ${p.rules.length}; draws ${p.draws.length}`);
    out(`WRITES change handler (sync) ms: median ${f(med(handler))} p90 ${f(q(handler, 0.9))} max ${f(Math.max(...handler))}; handler task incl. microtasks: median ${f(med(task))} p90 ${f(q(task, 0.9))}`);
    out(`WRITES draw task ms: median ${f(med(draws))} p90 ${f(q(draws, 0.9))} max ${f(Math.max(...draws))}; scopes sample: ${p.draws.slice(0, 6).map(d => d[2]).join(" | ")}`);
    summarize("idle page, sessions writing 3/s", profile, p.changes.length, "write");
    await bp.context.close();
  }

  // 2. Landings, quiet and writing: the test's busy time beside the time to land and what else fell into the window.
  for (const writing of [false, true]) {
    const { bp, cdp } = await openPage(browser, board);
    const w = writing ? startWriters(board, 3) : null;
    const rows: Array<{ busy: number; land: number; window: number; changes: number; changeMs: number; inputDelay: number; drawsMs: number; draws: number; landDraws: number }> = [];
    for (let presses = 0; rows.length < LANDINGS && presses < 8 * LANDINGS; presses++) {
      const was = await bp.selected(), b0 = await busyTime(cdp);
      await bp.page.keyboard.press("n");
      await quiet(bp);
      const end = await bp.page.evaluate(() => performance.now());
      const busy = await busyTime(cdp) - b0, now = await bp.selected(), p = await take(bp);
      if (now === null || now === was) continue;
      const cur = p.curAt.filter(x => x >= p.pressAt), land = cur.length ? Math.min(...cur) - p.pressAt : NaN;
      const ch = p.changes.filter(c => c[0] >= p.pressAt), key = p.keys.filter(k => Math.abs(k[0] - p.pressAt) < 50)[0];
      const landDraws = p.draws.filter(d => d[0] >= p.pressAt && (!cur.length || d[0] <= Math.min(...cur)));
      rows.push({ busy, land, window: end - p.pressAt, changes: ch.length, changeMs: ch.reduce((a, c) => a + c[2], 0), inputDelay: key ? key[1] : 0, drawsMs: p.draws.filter(d => d[0] >= p.pressAt).reduce((a, d) => a + d[1] - d[0], 0), draws: p.draws.filter(d => d[0] >= p.pressAt).length, landDraws: landDraws.length });
    }
    const written = w ? await w.stop() : 0;
    const label = writing ? `writing 3/s (${written} writes)` : "quiet";
    const col = (k: keyof typeof rows[number]) => rows.map(r => r[k]);
    const line = (name: string, xs: number[]) => out(`LAND ${label}: ${name.padEnd(34)} median ${f(med(xs)).padStart(5)}  p90 ${f(q(xs, 0.9)).padStart(5)}  max ${f(Math.max(...xs.filter(Number.isFinite))).padStart(5)}`);
    out(`LAND ${label}: ${rows.length} landings`);
    line("busy (the test's metric)", col("busy"));
    line("key to landed (current mark)", col("land"));
    line("key delay (keydown waited)", col("inputDelay"));
    line("window key..quiet", col("window"));
    line("change events in window", col("changes"));
    line("change handling ms in window", col("changeMs"));
    line("busy minus change handling", rows.map(r => r.busy - r.changeMs));
    line("draws in window", col("draws"));
    line("draws ms in window", col("drawsMs"));
    line("draws before landed", col("landDraws"));
    out(`LAND ${label}: rows busy/land/window/changes/changeMs: ${rows.map(r => [r.busy, r.land, r.window, r.changes, r.changeMs].map(f).join("/")).join(" ")}`);
    await bp.context.close();
  }
});
