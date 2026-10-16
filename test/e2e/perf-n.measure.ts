// Temporary measurement of one press of n on the owner's page, for the study page-n-fast-study (run by the
// perf-n workflow on a GitHub-hosted runner, never on the owner's Mac). It builds a board of the live board's
// size with hundreds of unread steps, loads the real page in headless Chromium and presses n many times,
// recording per press the main-thread time (CDP Performance.getMetrics deltas), the time until the DOM stopped
// changing, and long tasks; and, in a separate profiled pass, a V8 CPU profile aggregated by function.
//
// Usage: node test/e2e/perf-n.measure.ts [--scale 12] [--extra 330] [--presses 40] [--profile 30] [--reps 2]
//   [--writes 0] [--open none|all] [--variants head,noagents] [--commits a,b] [--out dir] [--label text]
import { once } from "node:events";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import type { Server } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import type { Browser, CDPSession } from "playwright";
import { rules } from "../../src/rules.ts";
import { ops } from "../../src/ops.ts";
import { ownerOps } from "../../src/owner-ops.ts";
import { createHttpServer } from "../../src/http.ts";
import { createMcpServer } from "../../src/mcp.ts";
import { generateBoard, prng } from "./board-gen.ts";
import { seedBoard } from "./seed.ts";
import { BoardPage, ROOT, variantWeb, openAll } from "./harness.ts";
import type { BoardServer } from "./harness.ts";

const { values: args } = parseArgs({ options: {
  scale: { type: "string", default: "12" }, extra: { type: "string", default: "330" }, presses: { type: "string", default: "40" },
  profile: { type: "string", default: "30" }, reps: { type: "string", default: "2" }, writes: { type: "string", default: "0" },
  open: { type: "string", default: "none" }, variants: { type: "string", default: "head" }, commits: { type: "string", default: "" },
  out: { type: "string", default: "perf-out" }, label: { type: "string", default: "run" }, "no-profile": { type: "boolean", default: false },
} });
const SCALE = Number(args.scale), EXTRA = Number(args.extra), PRESSES = Number(args.presses), PROFILE = Number(args.profile), REPS = Number(args.reps), WRITES = Number(args.writes);
const cleanups: Array<() => unknown> = [];
const t = { after: (fn: () => unknown) => { cleanups.push(fn); } };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const out = (line: string) => console.log(line);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN; };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
const f = (x: number) => Number.isFinite(x) ? x.toFixed(1) : "-";

/** The generated board plus `EXTRA` unread commits, each one write by a session to one open item. */
async function makeBoard(): Promise<BoardServer & { servers: Server[] }> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-perf-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const gen = generateBoard(1, SCALE);
  const t0 = Date.now();
  const { store } = await seedBoard(dir, gen);
  const snap0 = store.snapshot(), r0 = rules(snap0);
  const open = Object.keys(snap0.items).filter(id => !snap0.items[id]!.record && !/^(done|cancelled)$/.test(r0.statusOf(id) ?? ""));
  const rnd = prng(4242), pool = Array.from({ length: Math.max(1, Math.round(EXTRA * 0.7)) }, () => rnd.pick(open));
  const notesWithReply = Object.entries(snap0.notes).filter(([, n]) => n.kind === "comment" && n.reply).map(([id]) => id);
  for (let k = 0; k < EXTRA; k++) {
    const s = store.snapshot(), at = new Date(Date.now() + k * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), kind = k % 10;
    if (kind === 9 && notesWithReply.length) {
      const id = rnd.pick(notesWithReply), n = s.notes[id]!, { rev, ...doc } = n;
      await store.commit({ author: n.repliedBy ?? "Kestrel", message: "extra: reply", puts: [{ kind: "note", id, expectRev: rev, doc: { ...doc, reply: n.reply + " 补充。", repliedAt: at } }] });
      continue;
    }
    const id = rnd.pick(pool), it = s.items[id]!, { rev, ...doc } = it;
    let plan = it.plan;
    if (kind === 7 || kind === 8) {
      let flipped = false;
      plan = it.plan.map(row => !flipped && "state" in row && row.state === "todo" && !row.accept ? (flipped = true, { ...row, state: "doing" as const, since: at }) : row);
    }
    await store.commit({ author: it.group, message: "extra: progress", puts: [{ kind: "item", id, expectRev: rev, doc: { ...doc, plan, log: [...it.log, { at, by: it.group, text: "未读的进展 " + k + "。" }], updated: at } }] });
  }
  const snap = store.snapshot();
  const board = { url: "", store, gen, dir, servers: [] as Server[] };
  out(`BOARD scale=${SCALE} items=${Object.keys(snap.items).length} cards=${Object.keys(snap.decisions).length} notes=${Object.keys(snap.notes).length} extraCommits=${EXTRA} seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return board;
}
/** An HTTP server for the board serving the page from `webDir`; one board can be served by several pages. */
async function serve(board: BoardServer & { servers: Server[] }, webDir: string): Promise<string> {
  const op = ops(board.store);
  const server: Server = createHttpServer({ store: board.store, ops: op, ownerOps: ownerOps(board.store), webDir, createMcp: () => createMcpServer({ store: board.store, ops: op }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  board.servers.push(server);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}
/** The page at a past commit, built from that commit's web/ and src/ and served by the present server. */
async function pageAt(commit: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-at-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync("sh", ["-c", `git archive ${commit} web src | tar -x -C "${dir}"`], { cwd: ROOT });
  await symlink(join(ROOT, "node_modules"), join(dir, "node_modules"));
  await mkdir(join(dir, "web/dist"), { recursive: true });
  await build({ entryPoints: [join(dir, "web/app.ts")], bundle: true, format: "esm", target: "es2022", outfile: join(dir, "web/dist/app.js"), logLevel: "silent" });
  return join(dir, "web");
}

const INIT = `(() => {
  const log = window.__nlog = { t0: 0, last: 0, long: [] };
  addEventListener("keydown", e => { if (e.key === "n") { log.t0 = performance.now(); log.last = 0; log.long = []; } }, true);
  new MutationObserver(() => { if (log.t0) log.last = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) if (log.t0 && e.startTime >= log.t0) log.long.push([e.startTime - log.t0, e.duration]); }).observe({ type: "longtask" }); } catch {}
})();`;

type Metrics = Record<string, number>;
async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map(m => [m.name, m.value]));
}
interface Press { busy: number; script: number; layout: number; style: number; landed: number; longMax: number; longSum: number; selected: string | null }
interface Run { variant: string; presses: Press[]; control: number[]; distinct: number; stops: number; writes: number }

async function openPage(browser: Browser, board: BoardServer, url: string) {
  const bp = await BoardPage.open(browser, { ...board, url }, args.open === "all" ? openAll(board) : {});
  await bp.context.addInitScript({ content: INIT });
  // The init script only runs on later loads, so load the page again.
  await bp.reset(args.open === "all" ? openAll(board) : {});
  const cdp = await bp.context.newCDPSession(bp.page);
  await cdp.send("Performance.enable");
  await bp.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  return { bp, cdp };
}
function startWriter(board: BoardServer, perSec: number) {
  const r = prng(777); let stopped = false, count = 0;
  const ids = Object.keys(board.store.snapshot().items).filter(id => !board.store.snapshot().items[id]!.record);
  const loop = (async () => {
    while (!stopped) {
      const id = r.pick(ids), it = board.store.snapshot().items[id]!, { rev, ...doc } = it, at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      try { await board.store.commit({ author: it.group, message: "writer", puts: [{ kind: "item", id, expectRev: rev, doc: { ...doc, log: [...it.log, { at, by: it.group, text: "持续写入。" }], updated: at } }] }); count++; } catch { /* a lost race: skip */ }
      await sleep(1000 / perSec);
    }
  })();
  return { stop: async () => { stopped = true; await loop; return count; } };
}
async function pressOnce(bp: BoardPage, cdp: CDPSession): Promise<Press> {
  const m0 = await metrics(cdp);
  await bp.page.keyboard.press("n");
  await bp.settle(); await sleep(120); await bp.settle();
  const m1 = await metrics(cdp), log = await bp.page.evaluate(() => (window as unknown as { __nlog: { t0: number; last: number; long: Array<[number, number]> } }).__nlog);
  const d = (k: string) => (m1[k]! - m0[k]!) * 1000;
  return { busy: d("TaskDuration"), script: d("ScriptDuration"), layout: d("LayoutDuration"), style: d("RecalcStyleDuration"), landed: log.last ? log.last - log.t0 : NaN,
    longMax: Math.max(0, ...log.long.map(l => l[1])), longSum: log.long.reduce((a, l) => a + l[1], 0), selected: await bp.selected() };
}
async function idleWindow(bp: BoardPage, cdp: CDPSession): Promise<number> {
  const m0 = await metrics(cdp); await sleep(450); const m1 = await metrics(cdp);
  void bp; return (m1["TaskDuration"]! - m0["TaskDuration"]!) * 1000;
}

async function timing(browser: Browser, board: BoardServer, url: string, variant: string): Promise<Run> {
  const { bp, cdp } = await openPage(browser, board, url);
  const writer = WRITES > 0 ? startWriter(board, WRITES) : null;
  const presses: Press[] = [], control: number[] = [];
  for (let k = 0; k < PRESSES; k++) {
    presses.push(await pressOnce(bp, cdp));
    if (writer && k % 2 === 1) control.push(await idleWindow(bp, cdp));
  }
  const writes = writer ? await writer.stop() : 0;
  const stops = await bp.page.evaluate(() => Number((document.querySelector("#unread-row .sbtn.s-new")?.textContent ?? "").match(/\d+/)?.[0] ?? 0));
  await bp.context.close();
  return { variant, presses, control, distinct: new Set(presses.map(p => p.selected)).size, stops, writes };
}
function report(label: string, runs: Run[]) {
  for (const run of runs) {
    const busy = run.presses.map(p => p.busy), warm = busy.slice(5), landed = run.presses.map(p => p.landed).filter(Number.isFinite);
    out(`TIMING ${label} variant=${run.variant} presses=${busy.length} distinctLandings=${run.distinct} unreadStops=${run.stops} writes=${run.writes}`);
    out(`  busy ms (task time from press until quiet): median ${f(median(busy))} p90 ${f(pct(busy, 0.9))} max ${f(Math.max(...busy))} | after 5 warm-up presses: median ${f(median(warm))} p90 ${f(pct(warm, 0.9))}`);
    out(`  script ms median ${f(median(run.presses.map(p => p.script)))} layout ${f(median(run.presses.map(p => p.layout)))} style ${f(median(run.presses.map(p => p.style)))} | press until DOM stopped changing: median ${f(median(landed))} p90 ${f(pct(landed, 0.9))} | longest task median ${f(median(run.presses.map(p => p.longMax)))} max ${f(Math.max(...run.presses.map(p => p.longMax)))}`);
    if (run.control.length) out(`  control (no press, same writes, 450 ms window): median ${f(median(run.control))} max ${f(Math.max(...run.control))}`);
    out(`  busy per press: ${busy.map(x => x.toFixed(0)).join(" ")}`);
  }
}

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface CpuProfile { nodes: Node[]; samples: number[]; timeDeltas: number[] }
function summarize(label: string, profile: CpuProfile, presses: number) {
  const byId = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const key = (n: Node) => { const fr = n.callFrame; return (fr.functionName || "(anonymous)") + (fr.url ? " " + fr.url.split("/").pop() + ":" + (fr.lineNumber + 1) : ""); };
  const stacks = new Map<number, string[]>();
  const stackOf = (id: number): string[] => {
    let s = stacks.get(id); if (s) return s;
    const p = parent.get(id); s = [...(p === undefined ? [] : stackOf(p)), key(byId.get(id)!)]; stacks.set(id, s); return s;
  };
  const self = new Map<string, number>(), incl = new Map<string, number>(), entry = new Map<string, number>();
  let total = 0, idle = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000, st = stackOf(id), leaf = st[st.length - 1]!;
    if (leaf.startsWith("(idle)")) { idle += dt; return; }
    total += dt;
    self.set(leaf, (self.get(leaf) ?? 0) + dt);
    for (const k of new Set(st)) incl.set(k, (incl.get(k) ?? 0) + dt);
    const e = st.find(k => / app\.js:\d+$/.test(k)) ?? "(no page function: " + leaf.replace(/ .*/, "") + ")";
    entry.set(e, (entry.get(e) ?? 0) + dt);
  });
  const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${(v / presses).toFixed(1).padStart(7)} ms/press  ${k}`).join("\n");
  out(`PROFILE ${label}: ${presses} presses, ${(total / presses).toFixed(1)} ms/press sampled outside idle (profiler overhead included)`);
  out(`-- by outermost page function (where the work started)\n${top(entry, 14)}`);
  out(`-- by inclusive time (function and everything it calls)\n${top(incl, 45)}`);
  out(`-- by self time\n${top(self, 25)}`);
}
async function profiled(browser: Browser, board: BoardServer, url: string, label: string, dir: string) {
  const { bp, cdp } = await openPage(browser, board, url);
  const writer = WRITES > 0 ? startWriter(board, WRITES) : null;
  await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  for (let k = 0; k < 5; k++) await pressOnce(bp, cdp); // warm up before sampling
  await cdp.send("Profiler.start");
  for (let k = 0; k < PROFILE; k++) await pressOnce(bp, cdp);
  const { profile } = await cdp.send("Profiler.stop") as { profile: CpuProfile };
  if (writer) await writer.stop();
  await writeFile(join(dir, `${label}.cpuprofile`), JSON.stringify(profile));
  summarize(label, profile, PROFILE);
  await bp.context.close();
}

const dir = join(ROOT, args.out!);
await mkdir(dir, { recursive: true });
try {
  const board = await makeBoard();
  const browser = await chromium.launch(); t.after(() => browser.close());
  // Variants of the page: the present one, and ones with one suspect removed, to show what the removal changes.
  const pages = new Map<string, string>();
  for (const v of args.variants!.split(",").filter(Boolean)) {
    if (v === "head") pages.set(v, join(ROOT, "web"));
    else if (v === "noagents") pages.set(v, await variantWeb(t, [{ file: "web/app.ts", edit: "no agent list", find: "function renderAgents() {\n    const host = get(\"agents\"); if (!host) return;", replace: "function renderAgents() { return;\n    const host = get(\"agents\"); if (!host) return;" }]));
    else throw new Error("unknown variant " + v);
  }
  for (const c of args.commits!.split(",").filter(Boolean)) pages.set(c, await pageAt(c));
  const urls = new Map<string, string>();
  for (const [name, webDir] of pages) urls.set(name, await serve(board, webDir));
  // Interleaved: each repetition measures every variant once, in turn, so a slow minute on the runner hits all of them.
  const all: Run[][] = [];
  for (let rep = 0; rep < REPS; rep++) {
    const runs: Run[] = [];
    for (const [name, url] of urls) {
      try { runs.push(await timing(browser, board, url, name)); } catch (e) { out(`FAILED ${args.label} variant=${name} rep=${rep}: ${(e as Error).message.split("\n")[0]}`); }
    }
    report(`${args.label} rep ${rep + 1}`, runs); all.push(runs);
  }
  await writeFile(join(dir, `${args.label}-timing.json`), JSON.stringify(all));
  if (!args["no-profile"]) for (const [name, url] of urls) {
    try { await profiled(browser, board, url, `${args.label}-${name}`, dir); } catch (e) { out(`FAILED profile ${name}: ${(e as Error).message.split("\n")[0]}`); }
  }
} finally {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
}
process.exit(0);
