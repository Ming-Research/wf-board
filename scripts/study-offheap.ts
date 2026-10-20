// Study of the memory the daemon holds beyond its live heap (item board-offheap). One use: it stays on the branch while the study
// runs and is deleted before the pull request is ready (the numbers it printed go to docs/design.md, section 4).
//
// It builds a synthetic board of the live board's shape (the generator of the heap study: 1,942 items, 839 cards, 1,210 notes, text
// as block scalars), then for each variant (V8 flags and environment) starts the real daemon (src/main.ts) on a copy of it, and
// samples it while it starts, serves a fixed mix of requests like the live board's, idles, and collects:
//   in the process (a preload answers SIGUSR2): process.memoryUsage(), v8.getHeapStatistics(), v8.getHeapSpaceStatistics();
//   from the system: Linux /proc/<pid>/status and smaps_rollup, macOS `vmmap -summary` (the regions by type) and the physical footprint.
//
// Usage: node scripts/study-offheap.ts [--variants '<json>'] [--phases 4] [--per-phase 5000] [--conc 8] [--idle 30] [--scale 1]
//   variants: [{"name":"default","flags":[],"env":{}}, ...]
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashToken } from "../src/credentials.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: {
  variants: { type: "string", default: '[{"name":"default","flags":[],"env":{}}]' },
  phases: { type: "string", default: "4" }, "per-phase": { type: "string", default: "5000" }, conc: { type: "string", default: "8" },
  idle: { type: "string", default: "30" }, only: { type: "string" }, pairs: { type: "string" }, members: { type: "string" }, series: { type: "string", default: "15" }, scale: { type: "string", default: "1" }, "start-wait": { type: "string", default: "3" },
} });
const PHASES = Number(args.phases), PER_PHASE = Number(args["per-phase"]), CONC = Number(args.conc), IDLE = Number(args.idle), SCALE = Number(args.scale), START_WAIT = Number(args["start-wait"]);
/** A variant: V8 flags and environment for the daemon, and optionally the weights of the kinds of request (default: the live mix), the
 * requests per phase and a rate in requests a second (0: as fast as the daemon answers). */
interface Variant { name: string; flags: string[]; env: Record<string, string>; mix?: Record<string, number>; perPhase?: number; rate?: number; phases?: number; idle?: number }
const DEFINED = JSON.parse(args.variants!) as Variant[];
/** The runs in order: with `--pairs N --members a,b,c`, N rounds of a, b and c one after the other (interleaved, so that a slow stretch of the
 * runner lands on every member), else the variants named by `--only` (all by default). */
const RUNS: Array<{ variant: Variant; round: number }> = args.pairs !== undefined
  ? Array.from({ length: Number(args.pairs) }, (_, r) => args.members!.split(",").map(name => ({ variant: DEFINED.find(v => v.name === name)!, round: r + 1 }))).flat()
  : DEFINED.filter(v => args.only === undefined || v.name === args.only).map(variant => ({ variant, round: 1 }));
const SERIES_S = Number(args.series);
const LIVE_MIX: Record<string, number> = { unread: 40, step: 22, snapshot: 4, context: 12, list: 4, notes: 3, messages: 3, changes: 3, append_log: 9 };
const SHAPE = { items: Math.round(1942 * SCALE), decisions: Math.round(839 * SCALE), notes: Math.round(1210 * SCALE) };
const mb = (bytes: number) => +(bytes / 1048576).toFixed(1);
const sleep = (ms: number) => new Promise<void>(ok => setTimeout(ok, ms));
const MINUTE = 60_000, iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const yaml = (value: unknown) => stringify(value, { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" });

// ---- the synthetic board (from the heap study) ----------------------------------------------------------------------

const CJK = "看板服务读历史时只读需要的文件查清楚堆为什么会这么大的原因和各种改法的代价与风险验收数字";
const WORDS = ["board", "parse", "heap", "cost", "range", "commit", "item", "plan", "card", "note", "merge", "check"];
function block(bytes: number, seed: number): string {
  const lines: string[] = [];
  for (let i = 0, made = 0; made < bytes; i++) {
    if (i % 7 === 6) { lines.push(""); made += 1; continue; }
    const from = (i * 7 + seed) % (CJK.length - 18);
    let ascii = "";
    for (let k = 0; ascii.length < 27; k++) ascii += WORDS[(i + k + seed) % WORDS.length] + " ";
    const text = `${CJK.slice(from, from + 18)} ${ascii.trim()}`;
    lines.push(text);
    made += Buffer.byteLength(text) + 1;
  }
  return lines.join("\n");
}
const PROJECTS = ["Whitefoot", "Firn", "Halo", "Snowghost", "kit", "Architect"];
function blockBoard(n: { items: number; decisions: number; notes: number }): { files: Map<string, string>; ids: string[] } {
  const files = new Map<string, string>(), start = Date.UTC(2026, 9, 1), at = iso(start), ids: string[] = [];
  for (let i = 0; i < n.items; i++) ids.push(`p${i % PROJECTS.length}-${Math.floor(i / PROJECTS.length)}`);
  const decisions: string[] = [];
  for (let k = 0; k < n.decisions; k++) {
    decisions.push(`c${k}`);
    files.set(`decisions/c${k}.yaml`, yaml({ num: n.items + k + 1, item: ids[(k * 7) % ids.length], question: `卡 ${k} 要问什么？`, kind: "design",
      options: [{ key: "A", text: "", detail: block(1100, k), recommended: true }, { key: "B", text: "", detail: block(900, k + 1) }, { key: "C", text: "", detail: block(700, k + 2) }],
      confidence: { score: 4, reason: block(300, k + 3) }, status: "ruled", choice: "A", ruling: block(200, k + 4), ruledAt: at, at, updated: at, rev: 1 }));
  }
  for (let k = 0; k < n.notes; k++) files.set(`notes/n${k}.yaml`, yaml({ target: k % 2 === 0 ? `q:${decisions[k % decisions.length]}` : `it:${ids[(k * 5) % ids.length]}`, kind: "comment", text: block(300, k), at, state: "done", sentAt: at, reply: block(200, k + 1), repliedAt: at, repliedBy: "Firn", rev: 1 }));
  ids.forEach((id, i) => {
    const rows = Array.from({ length: 8 }, (_, k) => ({ id: `s${k}`, text: `步骤 ${k}: 要做的事，写成一句话 ${id}`, state: "done", doneAt: at }));
    files.set(`items/${id}.yaml`, yaml({ num: i + 1, title: `条目 ${id} 的标题，写成一句话`, group: PROJECTS[i % PROJECTS.length], difficulty: 2, head: block(4200, i),
      log: Array.from({ length: 12 }, (_, k) => ({ at: iso(start + k * MINUTE), by: PROJECTS[i % PROJECTS.length], text: block(240, i * 13 + k) })),
      plan: [...rows, { id: "accept", text: "验收：每个问题都有回答", state: "todo", accept: true }],
      links: [{ label: "wf-board#1", url: "https://github.com/Ming-Research/wf-board/pull/1" }], created: at, updated: at, rev: 13 }));
  });
  files.set("board.yaml", yaml({ title: "Synthetic board", projects: PROJECTS.map(name => ({ name })) }));
  files.set("numbers.yaml", yaml({ next: n.items + n.decisions + 1 }));
  return { files, ids };
}
function writeBoard(dir: string, files: Map<string, string>): void {
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=study", "-c", "user.email=study@example.invalid", "commit", "-q", "-m", "Seed synthetic board"], { cwd: dir });
}

// ---- the samples ----------------------------------------------------------------------------------------------------

/** Read in the daemon through SIGUSR2; the command file says whether to collect first. */
const PRELOAD = `import v8 from "node:v8"; import vm from "node:vm"; import { writeFileSync, readFileSync } from "node:fs"; import { PerformanceObserver } from "node:perf_hooks";
v8.setFlagsFromString("--expose-gc"); const gc = vm.runInNewContext("gc");
for (const flag of (process.env.STUDY_V8_FLAGS ?? "").split(" ").filter(Boolean)) v8.setFlagsFromString(flag);
const gcs = { minor: [0, 0], major: [0, 0], incremental: [0, 0], other: [0, 0] };
new PerformanceObserver(list => { for (const e of list.getEntries()) { const k = e.detail?.kind ?? e.kind; const name = k === 1 ? "minor" : k === 4 ? "major" : k === 8 ? "incremental" : "other"; gcs[name][0]++; gcs[name][1] += e.duration; } }).observe({ entryTypes: ["gc"] });
process.on("SIGUSR2", () => {
  const cmd = readFileSync(process.env.STUDY_CMD, "utf8").trim();
  if (cmd === "gc") { gc(); gc(); }
  const cpu = process.cpuUsage();
  writeFileSync(process.env.STUDY_STATS, JSON.stringify({ cmd, heap: v8.getHeapStatistics(), spaces: v8.getHeapSpaceStatistics(), mem: process.memoryUsage(), cpuMs: (cpu.user + cpu.system) / 1000, gcs }));
});`;

const SIZE = /^([\d.]+)([KMG]?)$/;
const sizeMB = (token: string): number => { const m = SIZE.exec(token); if (!m) return 0; const n = Number(m[1]); return m[2] === "G" ? n * 1024 : m[2] === "M" ? n : m[2] === "K" ? n / 1024 : n / 1048576; };

/** macOS: the physical footprint and the resident and dirty size of each region type from `vmmap -summary`. */
function vmmap(pid: number): Record<string, number> {
  const text = execFileSync("vmmap", ["-summary", String(pid)], { encoding: "utf8", maxBuffer: 64 << 20 });
  const out: Record<string, number> = {};
  const footprint = /Physical footprint:\s+(\S+)/.exec(text)?.[1], peak = /Physical footprint \(peak\):\s+(\S+)/.exec(text)?.[1];
  if (footprint) out.footprintMB = +sizeMB(footprint).toFixed(1);
  if (peak) out.footprintPeakMB = +sizeMB(peak).toFixed(1);
  const row = /^(\S.*?)\s{2,}(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)/;
  let inTable = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("REGION TYPE")) { inTable = true; continue; }
    if (!inTable) continue;
    if (line.startsWith("TOTAL,") || line.startsWith("MALLOC ZONE")) break;
    const m = row.exec(line);
    if (!m || m[1]!.startsWith("===")) continue;
    const name = m[1]!.trim(), resident = sizeMB(m[3]!), dirty = sizeMB(m[4]!), swapped = sizeMB(m[5]!);
    out[`${name} res`] = +((out[`${name} res`] ?? 0) + resident).toFixed(1);
    out[`${name} dirty+swap`] = +((out[`${name} dirty+swap`] ?? 0) + dirty + swapped).toFixed(1);
    out[`${name} virt`] = +((out[`${name} virt`] ?? 0) + sizeMB(m[2]!)).toFixed(1);
  }
  const group = (re: RegExp, suffix: string) => +Object.entries(out).filter(([k]) => re.test(k) && k.endsWith(suffix)).reduce((n, [, v]) => n + v, 0).toFixed(1);
  out["V8 pages res"] = group(/^(Memory Tag 255|App-Specific Tag 16)(?! \()/, " res");
  out["V8 pages dirty+swap"] = group(/^(Memory Tag 255|App-Specific Tag 16)(?! \()/, " dirty+swap");
  out["malloc res"] = group(/^(MALLOC|Malloc)/, " res");
  out["malloc dirty+swap"] = group(/^(MALLOC|Malloc)/, " dirty+swap");
  out["malloc empty res"] = group(/^(MALLOC|Malloc).*\(empty\)/, " res");
  const zone = /DefaultMallocZone\S*\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)%/.exec(text);
  if (zone) { out["malloc zone allocated"] = +sizeMB(zone[6]!).toFixed(1); out["malloc zone frag"] = +sizeMB(zone[7]!).toFixed(1); }
  return out;
}

/** Linux: the resident set by kind from /proc. */
function proc(pid: number): Record<string, number> {
  const out: Record<string, number> = {};
  const kb = (text: string, name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? 0) / 1024;
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  for (const name of ["VmRSS", "RssAnon", "RssFile", "RssShmem", "VmHWM"]) out[name] = +kb(status, name).toFixed(1);
  try {
    const roll = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    for (const name of ["Pss", "Private_Dirty", "Private_Clean", "Shared_Clean", "Anonymous"]) out[name] = +kb(roll, name).toFixed(1);
  } catch { /* no smaps_rollup */ }
  return out;
}

interface Sample { phase: string; cpuMs: number; gcs: Record<string, [number, number]>; ps: number; os: Record<string, number>; v8: Record<string, number>; spaces: Record<string, { size: number; used: number; physical: number }>; }

async function startDaemon(dir: string, variant: { flags: string[]; env: Record<string, string> }, token: string, credentials: string) {
  const port = 17400 + Math.floor(Math.random() * 500), stats = join(tmpdir(), `study-offheap-stats-${process.pid}.json`), cmd = join(tmpdir(), `study-offheap-cmd-${process.pid}.txt`);
  writeFileSync(cmd, "");
  const child = spawn(process.execPath, [...variant.flags, "--import", `data:text/javascript,${encodeURIComponent(PRELOAD)}`, join(here, "../src/main.ts")], {
    env: { ...process.env, ...variant.env, WF_BOARD_DATA: dir, WF_BOARD_PORT: String(port), WF_BOARD_FIRST_PUSH_MS: "3600000", WF_BOARD_CREDENTIALS: credentials, STUDY_STATS: stats, STUDY_CMD: cmd },
    stdio: ["ignore", "pipe", "pipe"] });
  let log = "", startup = "";
  const take = (d: Buffer) => { log += d; if (log.length > 200_000) log = log.slice(-100_000); const m = /startup memory: [^\n]*/.exec(String(d)); if (m) startup = m[0]; };
  child.stdout.on("data", take); child.stderr.on("data", take);
  let healthy = false;
  for (let i = 0; i < 600 && !healthy && child.exitCode === null; i++) {
    healthy = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false);
    if (!healthy) await sleep(200);
  }
  if (!healthy) { child.kill("SIGKILL"); throw new Error(`the daemon did not answer /health: ${log.slice(-1500)}`); }
  const sample = async (phase: string, collect = false): Promise<Sample> => {
    writeFileSync(cmd, collect ? "gc" : "");
    rmSync(stats, { force: true });
    child.kill("SIGUSR2");
    for (let i = 0; i < 300 && !existsSync(stats); i++) await sleep(100);
    await sleep(200);
    const j = JSON.parse(readFileSync(stats, "utf8")) as { heap: Record<string, number>; spaces: Array<{ space_name: string; space_size: number; space_used_size: number; physical_space_size: number }>; mem: Record<string, number>; cpuMs: number; gcs: Record<string, [number, number]> };
    const os = process.platform === "darwin" ? vmmap(child.pid!) : proc(child.pid!);
    const ps = Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" }).trim()) / 1024;
    const v8 = { rss: mb(j.mem.rss!), heapTotal: mb(j.mem.heapTotal!), heapUsed: mb(j.mem.heapUsed!), external: mb(j.mem.external!), arrayBuffers: mb(j.mem.arrayBuffers!),
      physical: mb(j.heap.total_physical_size!), malloced: mb(j.heap.malloced_memory!), peakMalloced: mb(j.heap.peak_malloced_memory!), globalHandles: mb(j.heap.total_global_handles_size!), limit: mb(j.heap.heap_size_limit!) };
    const spaces = Object.fromEntries(j.spaces.map(s => [s.space_name, { size: mb(s.space_size), used: mb(s.space_used_size), physical: mb(s.physical_space_size) }]));
    return { phase, cpuMs: Math.round(j.cpuMs), gcs: j.gcs, ps: +ps.toFixed(1), os, v8, spaces };
  };
  return { child, port, sample, log: () => log, startup: () => startup };
}

// ---- the load -------------------------------------------------------------------------------------------------------

/** A seeded generator, so every variant is served the same sequence. */
function prng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

/** The kinds of request in the weights of `mix` (the live board's counted in its service log by default): page reads of the unread
 * list and its steps, snapshots, the tools agents call, and a few writes. The page's read cursor never moves, so the writes add unread commits. */
async function load(port: number, token: string, ids: string[], count: number, seed: number, mix: Record<string, number>, rate: number): Promise<{ writes: number; ms: number; failed: Record<string, string>; latency: Record<string, number[]> }> {
  const rnd = prng(seed), base = `http://127.0.0.1:${port}`;
  const client = new Client({ name: "study", version: "1" }); client.onerror = () => {};
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  let steps: Array<{ id: string; docs: Array<{ kind: string; id: string }> }> = [];
  let writes = 0, next = 0;
  const failed: Record<string, string> = {};
  const fail = (kind: string, why: string) => { const key = `${kind}`; failed[key] = failed[key] === undefined ? `1: ${why.slice(0, 160)}` : `${Number.parseInt(failed[key]!) + 1}${failed[key]!.slice(failed[key]!.indexOf(":"))}`; };
  const kinds = Object.keys(mix), total = kinds.reduce((n, k) => n + mix[k]!, 0);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const get = async (kind: string, path: string) => { const r = await fetch(base + path); if (!r.ok) { fail(kind, `${r.status} ${(await r.text()).slice(0, 100)}`); return undefined; } return await r.json() as unknown; };
  const call = async (kind: string, name: string, a: Record<string, unknown>) => { const res = await client.callTool({ name, arguments: a }).catch(error => ({ isError: true, content: [{ text: String(error) }] })); if (res.isError) fail(kind, JSON.stringify(res.content).slice(0, 200)); };
  const started = performance.now();
  const times: Record<string, number[]> = {};
  const one = async () => {
    const t0 = performance.now();
    const kind = await oneRequest();
    (times[kind] ??= []).push(performance.now() - t0);
  };
  const oneRequest = async (): Promise<string> => {
    let r = rnd() * total, kind = kinds[0]!;
    for (const k of kinds) { if (r < mix[k]!) { kind = k; break; } r -= mix[k]!; }
    if (kind === "step" && steps.length === 0) kind = "unread";
    switch (kind) {
      case "unread": { const j = await get(kind, "/api/unread") as { steps?: typeof steps } | undefined; if (j?.steps) steps = j.steps; break; }
      case "step": { const s = pick(steps), d = s.docs[0]; if (d) await get(kind, `/api/step?id=${encodeURIComponent(s.id)}&kind=${d.kind}&doc=${encodeURIComponent(d.id)}`); break; }
      case "snapshot": await get(kind, "/api/snapshot"); break;
      case "context": await call(kind, "context", { id: pick(ids) }); break;
      case "list": await call(kind, "list", {}); break;
      case "notes": await call(kind, "notes", {}); break;
      case "messages": await call(kind, "messages", {}); break;
      case "changes": await call(kind, "changes", { since: "2026-10-01T00:00:00Z" }); break;
      case "append_log": writes++; await call(kind, "append_log", { id: pick(ids), text: `study write ${writes}: ${"进展 ".repeat(20)}` }); break;
      default: throw new Error(`unknown kind ${kind}`);
    }
    return kind;
  };
  const worker = async () => {
    while (next < count) {
      const n = next++;
      if (rate > 0) { const wait = started + (n / rate) * 1000 - performance.now(); if (wait > 0) await sleep(wait); }
      await one();
    }
  };
  // Unread steps need the list once before the first step is asked for.
  await get("unread", "/api/unread").then(j => { const s = (j as { steps?: typeof steps } | undefined)?.steps; if (s) steps = s; });
  await Promise.all(Array.from({ length: CONC }, worker));
  await client.close().catch(() => {});
  return { writes, ms: Math.round(performance.now() - started), failed, latency: times };
}

// ---- driver ---------------------------------------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "study-offheap-"));
const TOKEN = "wfb_study-offheap-token";
const credentials = join(root, "credentials.json");
writeFileSync(credentials, JSON.stringify({ credentials: [{ session: "架构师·study", role: "架构师", project: "Architect", roots: [], hash: hashToken(TOKEN) }] }));
const board = join(root, "board-seed");
mkdirSync(board);
const built = performance.now();
const { files, ids } = blockBoard(SHAPE);
writeBoard(board, files);
console.log(`platform ${process.platform} ${process.arch}, node ${process.version}, board: ${SHAPE.items} items, ${SHAPE.decisions} cards, ${SHAPE.notes} notes, ${files.size} files, built in ${Math.round(performance.now() - built)} ms`);

const results: Array<{ variant: string; round: number; flags: string[]; env: Record<string, string>; startupLine: string; samples: Sample[]; loads: Array<Awaited<ReturnType<typeof load>>>; series: Sample[] }> = [];
try {
  for (const { variant, round } of RUNS) {
    const dir = join(root, `board-${variant.name}-${round}`);
    cpSync(board, dir, { recursive: true });
    const samples: Sample[] = [], loads: Array<Awaited<ReturnType<typeof load>>> = [], series: Sample[] = [];
    let daemon;
    try { daemon = await startDaemon(dir, variant, TOKEN, credentials); }
    catch (error) { console.log(`STUDY ${JSON.stringify({ variant: variant.name, round, failed: String(error).slice(0, 800) })}`); continue; }
    try {
      await sleep(START_WAIT * 1000);
      samples.push(await daemon.sample("start"));
      for (let p = 1; p <= (variant.phases ?? PHASES); p++) {
        // While the requests are served, a sample every SERIES_S seconds.
        let running = true;
        const sampler = (async () => {
          while (running) {
            for (let waited = 0; running && waited < SERIES_S; waited++) await sleep(1000);
            if (running) series.push(await daemon.sample("series"));
          }
        })();
        loads.push(await load(daemon.port, TOKEN, ids, variant.perPhase ?? PER_PHASE, 1000 + p, variant.mix ?? LIVE_MIX, variant.rate ?? 0));
        running = false; await sampler;
        samples.push(await daemon.sample(`load ${p}`));
      }
      await sleep((variant.idle ?? IDLE) * 1000);
      samples.push(await daemon.sample(`idle ${variant.idle ?? IDLE}s`));
      samples.push(await daemon.sample("after full gc", true));
      await sleep(10_000);
      samples.push(await daemon.sample("gc + 10s"));
    } finally { daemon.child.kill("SIGTERM"); await sleep(500); }
    const startupLine = daemon.startup();
    results.push({ variant: variant.name, round, flags: variant.flags, env: variant.env, startupLine, samples, loads, series });
    console.log(`STUDY ${JSON.stringify(results.at(-1))}`);
    console.log(`finished ${variant.name} round ${round}`);
    rmSync(dir, { recursive: true, force: true });
  }
} finally { rmSync(root, { recursive: true, force: true }); }

// A table per variant for the run's summary.
const darwin = process.platform === "darwin";
for (const r of results) {
  console.log(`\n### ${r.variant} (${r.flags.join(" ") || "no flags"}${Object.keys(r.env).length ? "; " + JSON.stringify(r.env) : ""}) on ${process.platform}`);
  console.log(`startup line: ${r.startupLine.replace(/^\S+\s/, "")}; loads: ${JSON.stringify(r.loads.map(l => ({ writes: l.writes, ms: l.ms, failed: l.failed })))}`);
  // What the owner sees: the footprint (macOS) or the anonymous resident set (Linux), over the series taken while the load ran.
  const metric = (x: Sample) => darwin ? x.os.footprintMB! : x.os.RssAnon!;
  const values = r.series.map(metric).sort((a, b) => a - b);
  const q = (xs: number[], f: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(f * xs.length))]! : NaN;
  const first = r.samples[0]!, last = r.samples.find(x => x.phase.startsWith("load"))!, endLoad = [...r.samples].reverse().find(x => x.phase.startsWith("load"))!;
  const requests = r.loads.reduce((n, l) => n + Object.values(l.latency).reduce((m, xs) => m + xs.length, 0), 0);
  const all = r.loads.flatMap(l => Object.values(l.latency).flat()).sort((a, b) => a - b);
  const gcTotal = (x: Sample, kind: string) => x.gcs[kind] ?? [0, 0];
  const gcMs = Object.keys(endLoad.gcs).reduce((n, k) => n + gcTotal(endLoad, k)[1] - gcTotal(first, k)[1], 0);
  console.log(`series of ${values.length} samples (${darwin ? "footprint" : "RssAnon"} MB): mean ${(values.reduce((n, v) => n + v, 0) / (values.length || 1)).toFixed(0)}, p50 ${q(values, 0.5)}, p95 ${q(values, 0.95)}, max ${values.at(-1)}; start ${metric(first)}; after the load ${metric(endLoad)}; idle ${metric(r.samples.find(x => x.phase.startsWith("idle"))!)}; ${last.phase}`);
  console.log(`cost: ${requests} requests, cpu ${((endLoad.cpuMs - first.cpuMs) / 1000).toFixed(1)} s (${((endLoad.cpuMs - first.cpuMs) / (requests || 1)).toFixed(2)} ms a request), gc ${gcMs.toFixed(0)} ms (minor ${gcTotal(endLoad, "minor")[0] - gcTotal(first, "minor")[0]}, major ${gcTotal(endLoad, "major")[0] - gcTotal(first, "major")[0]}, incremental ${gcTotal(endLoad, "incremental")[0] - gcTotal(first, "incremental")[0]}); latency ms p50 ${q(all, 0.5).toFixed(1)}, p95 ${q(all, 0.95).toFixed(1)}, p99 ${q(all, 0.99).toFixed(1)}, max ${all.at(-1)?.toFixed(0)}`);
  const cols = darwin
    ? ["phase", "ps rss", "footprint", "V8 pages res", "malloc empty res", "malloc res", "page table", "footprint peak", "heapTotal", "heapUsed", "new", "old", "lo", "code", "external", "arrayBuf", "malloced"]
    : ["phase", "ps rss", "RssAnon", "RssFile", "HWM", "heapTotal", "heapUsed", "new", "old", "lo", "code", "external", "arrayBuf", "malloced"];
  console.log(`| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|`);
  for (const s of r.samples) {
    const os = s.os, sp = s.spaces;
    const malloc = os["malloc res"] ?? 0;
    const lo = (sp.large_object_space?.size ?? 0) + (sp.new_large_object_space?.size ?? 0);
    const row = darwin
      ? [s.phase, s.ps, os.footprintMB, os["V8 pages res"], os["malloc empty res"], +malloc.toFixed(1), os["page table in kernel res"], os.footprintPeakMB, s.v8.heapTotal, s.v8.heapUsed, sp.new_space?.size, sp.old_space?.size, +lo.toFixed(1), sp.code_space?.size, s.v8.external, s.v8.arrayBuffers, s.v8.malloced]
      : [s.phase, s.ps, os.RssAnon, os.RssFile, os.VmHWM, s.v8.heapTotal, s.v8.heapUsed, sp.new_space?.size, sp.old_space?.size, +lo.toFixed(1), sp.code_space?.size, s.v8.external, s.v8.arrayBuffers, s.v8.malloced];
    console.log(`| ${row.join(" | ")} |`);
  }
}
