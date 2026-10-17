// Temporary probe for the study n-writes-stable-study (not for merge): what a session's write costs the page, and what the
// press-n time while sessions write is made of. Run by the temporary workflow probe-writes.yml on the study branch only.

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


/** Everything a Rules object answers, for every item: two objects that agree here agree for the page and the server. */
function answers(r: Rules, s: Pick<Snapshot, "items">): string {
  const ids = Object.keys(s.items).sort();
  return JSON.stringify([r.areas(), ids.map(id => [id, r.statusOf(id), r.priorityOf(id), r.checks(id), r.refusals(id), r.planRows(id), r.depsOf(id), r.dependents(id), r.isNeeded(id), r.canStart(id), r.startable(id), r.progress(id),
    r.stalledBelow(id), r.blockingBelow(id), r.nonBlockingBelow(id), r.pausedBy(id), r.isOpenWork(id), r.isRoot(id), r.isBacklog(id), r.children(id), r.ancestors(id), r.onCycle(id), r.needsOwner(id), r.workedOn(id),
    r.planRatio(id), r.mentionedBy(id), r.cardsOf(id), r.parentOf(id)])]);
}
/** A random write of the kinds sessions make, most of which change nothing the statuses read. */
function mutate(rnd: ReturnType<typeof prng>, s: Snapshot, k: number): { s: Snapshot; id: string; kind: string } {
  const ids = Object.keys(s.items), id = rnd.pick(ids), it = s.items[id]!, at = new Date(Date.parse("2026-10-17T12:00:00Z") + k * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const kinds = ["log", "log", "log", "head", "head", "title", "tags", "difficulty", "plan-doing", "plan-done", "cardline"];
  const kind = rnd.pick(kinds);
  let next: Item = { ...it, updated: at };
  if (kind === "log") next.log = [...it.log, { at, by: it.group, text: "进展 " + k }];
  else if (kind === "head") next.head = (it.head ?? "") + "\n\n补充 " + k;
  else if (kind === "title") next.title = it.title.length > 30 ? it.title.slice(0, 8) : it.title + " 很长很长很长很长很长很长很长很长的标题";
  else if (kind === "tags") next.tags = it.tags?.length ? [] : ["看板"];
  else if (kind === "difficulty") next.difficulty = it.difficulty === undefined ? 2 : undefined;
  else if (kind === "cardline") { const cards = Object.entries(s.decisions).filter(([, d]) => d.item === id).map(([key]) => key); next.head = cards.length && rnd.chance(0.5) ? (it.head ?? "") + "\n[[q:" + cards[0] + "]]\n" : (it.head ?? "").replace(/\n\[\[q:[^\]]+\]\]/g, ""); }
  else {
    let done = false;
    next.plan = it.plan.map(row => !done && "state" in row && (kind === "plan-doing" ? row.state === "todo" : row.state === "doing") ? (done = true, kind === "plan-doing" ? { ...row, state: "doing" as const, since: at } : { ...row, state: "done" as const, doneAt: at }) : row);
  }
  if (next.difficulty === undefined) delete next.difficulty;
  return { s: { ...s, items: { ...s.items, [id]: next } }, id, kind };
}

async function pageOf(root: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "probe-page-"));
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "index.html"), await readFile(join(root, "web/index.html")));
  await symlink(join(ROOT, "web/dist/mermaid.js"), join(dir, "dist/mermaid.js"));
  await build({ entryPoints: [join(root, "web/app.ts")], bundle: true, format: "esm", target: "es2022", outfile: join(dir, "dist/app.js"), logLevel: "silent" });
  return dir;
}

/** One run of one page: the main thread per write with no key pressed, then landings while sessions write. */
async function cell(browser: Browser, board: BoardServer, landingsWanted: number) {
  const { bp, cdp } = await openPage(browser, board);
  const warm = startWriters(board, 3); await sleep(2500); await warm.stop(); await quiet(bp); await take(bp);
  const c0 = await bp.changes(), b0 = await busyTime(cdp);
  const w = startWriters(board, 3); await sleep(6000); await w.stop(); await quiet(bp);
  const perWrite = (await busyTime(cdp) - b0) / Math.max(1, await bp.changes() - c0);
  await take(bp);
  const w2 = startWriters(board, 3);
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
  await w2.stop();
  await bp.context.close();
  return { perWrite, busy: med(busy), busy90: q(busy, 0.9), land: med(land), land90: q(land, 0.9) };
}
/** Mean of the log ratios and its 95% interval (t distribution), as ratios. */
function interval(ratios: number[]) {
  const T = [12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09];
  const l = ratios.map(Math.log), n = l.length, m = l.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(l.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)), h = (T[n - 2] ?? 2.0) * sd / Math.sqrt(n);
  return { ratio: Math.exp(m), lo: Math.exp(m - h), hi: Math.exp(m + h), half: (Math.exp(h) - 1) };
}

test("probe: reused rules agree with fresh ones; base, twin and candidate pages compared in interleaved pairs", { timeout: 60 * 60_000 }, async t => {
  const board = await startLiveBoard(t), browser = await launch(t);
  await mkdir("probe-out", { recursive: true });

  // 0. The oracle: after each random write, rules that reuse the previous ones answer exactly what rules built from nothing answer.
  {
    const rnd = prng(99), T0 = Date.parse("2026-10-17T12:00:00Z");
    let s = board.store.snapshot() as Snapshot, r = rules(s, T0);
    answers(r, s);
    let mismatches = 0, k = 0, rNow = T0, reusedBefore = reuseStats.reused, pending: { r: Rules; s: Snapshot; now: number; k: number; kind: string; id: string } | undefined;
    const kinds = new Map<string, number>();
    // Each Rules object is checked only after the next one was built from it, so every build reuses a cache the page would leave:
    // half its answers asked, the other half not.
    const check = (p: NonNullable<typeof pending>) => { if (answers(rules(p.s, p.now), p.s) !== answers(p.r, p.s)) { mismatches++; if (mismatches <= 5) out(`ORACLE mismatch after write ${p.k} (${p.kind} on ${p.id})`); } };
    for (; k < Number(process.env.PROBE_ORACLE_WRITES ?? 150); k++) {
      const m = mutate(rnd, s, k), at = T0 + (k % 50) * 1000;
      const next = rules(m.s, at, { previous: { rules: r, changed: [{ kind: "item", id: m.id }] } });
      // A reused Rules object answers for the time its first ancestor in the chain was built at, as DerivedCache does within a minute.
      if (reuseStats.reused === reusedBefore) rNow = at;
      reusedBefore = reuseStats.reused;
      if (pending) check(pending);
      for (const id of Object.keys(m.s.items)) if (rnd.chance(0.5)) { next.statusOf(id); next.priorityOf(id); next.checks(id); }
      pending = { r: next, s: m.s, now: rNow, k, kind: m.kind, id: m.id };
      kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + 1);
      s = m.s; r = next;
    }
    if (pending) check(pending);
    out(`ORACLE ${k} writes (${[...kinds].map(([a, b]) => a + " " + b).join(", ")}): ${mismatches} mismatches; reused ${reuseStats.reused}, rebuilt ${reuseStats.rebuilt}`);
  }

  // 1. Interleaved pairs: base (the main line), its twin (the same source built again) and the candidate (this branch).
  const base = process.env.PROBE_BASE!, pages = { base: await pageOf(base), twin: await pageOf(base), cand: await pageOf(ROOT) };
  const served = { base: await serveBoard(t, board, pages.base), twin: await serveBoard(t, board, pages.twin), cand: await serveBoard(t, board, pages.cand) };
  const PAIRS = Number(process.env.PROBE_PAIRS ?? 10), LANDINGS_PER_CELL = Number(process.env.PROBE_CELL_LANDINGS ?? 12);
  const runs: Array<Record<"base" | "twin" | "cand", Awaited<ReturnType<typeof cell>>>> = [];
  const orders: Array<Array<"base" | "twin" | "cand">> = [["base", "twin", "cand"], ["cand", "base", "twin"], ["twin", "cand", "base"]];
  for (let i = 0; i < PAIRS; i++) {
    const row = {} as Record<"base" | "twin" | "cand", Awaited<ReturnType<typeof cell>>>;
    for (const v of orders[i % 3]!) row[v] = await cell(browser, served[v], LANDINGS_PER_CELL);
    runs.push(row);
    out(`PAIR ${i}: ` + (["base", "twin", "cand"] as const).map(v => `${v} perWrite ${f(row[v].perWrite)} busy ${f(row[v].busy)}/${f(row[v].busy90)} land ${f(row[v].land)}/${f(row[v].land90)}`).join(" | "));
  }
  for (const metric of ["perWrite", "busy", "busy90", "land", "land90"] as const) {
    const twin = interval(runs.map(r => r.twin[metric] / r.base[metric])), cand = interval(runs.map(r => r.cand[metric] / r.base[metric]));
    out(`CELL ${metric}: base median ${f(med(runs.map(r => r.base[metric])))}, cand median ${f(med(runs.map(r => r.cand[metric])))}; twin/base ${twin.ratio.toFixed(3)} [${twin.lo.toFixed(3)}, ${twin.hi.toFixed(3)}] noise ±${(twin.half * 100).toFixed(1)}%; cand/base ${cand.ratio.toFixed(3)} [${cand.lo.toFixed(3)}, ${cand.hi.toFixed(3)}]`);
  }

  // 2. Where the candidate's write still goes.
  {
    const { bp, cdp } = await openPage(browser, served.cand);
    const warm = startWriters(board, 3); await sleep(3000); await warm.stop(); await quiet(bp);
    await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    const c0 = await bp.changes();
    await cdp.send("Profiler.start");
    const w = startWriters(board, 3); await sleep(PROFILE_SECONDS * 1000); await w.stop(); await quiet(bp);
    const { profile } = await cdp.send("Profiler.stop") as { profile: CpuProfile };
    summarize("candidate page, sessions writing 3/s", profile, await bp.changes() - c0, "write");
    await bp.context.close();
  }
});
