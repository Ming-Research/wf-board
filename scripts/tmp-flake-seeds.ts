// TEMPORARY probe for the item e2e-git-tmp-flake-study; removed before the branch is ready.
// Seeds the e2e board into a fresh repository many times, as test/e2e/harness.ts does, with git's process trace on, and
// reports per seed: did the seed fail (and with what), did a background git process (gc, repack, prune) run, and did a
// `git add` of the seed overlap it in time.

import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateBoard } from "../test/e2e/board-gen.ts";
import { seedBoard } from "../test/e2e/seed.ts";

const [mode = "default", runsArg = "10", detail = ""] = process.argv.slice(2);
const MODES: Record<string, Record<string, string>> = {
  default: {},
  off: { "gc.auto": "0", "maintenance.auto": "false" },
  nodetach: { "gc.autoDetach": "false", "maintenance.autoDetach": "false" },
  eager: { "gc.auto": "1" },
};
const settings = Object.entries(MODES[mode] ?? (() => { throw new Error("mode " + mode); })());
process.env.GIT_CONFIG_COUNT = String(settings.length);
settings.forEach(([k, v], i) => { process.env[`GIT_CONFIG_KEY_${i}`] = k; process.env[`GIT_CONFIG_VALUE_${i}`] = v; });

interface Proc { sid: string; start: number; end: number; argv: string[]; hierarchy: string }
const us = (t: string) => { const m = /^(.*)\.(\d{6})Z$/.exec(t)!; return Date.parse(m[1] + "Z") * 1000 + Number(m[2]); };
function processes(trace: string): Proc[] {
  const byId = new Map<string, Proc>();
  for (const line of trace.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { event: string; sid: string; time: string; argv?: string[]; hierarchy?: string };
    const t = us(e.time), p = byId.get(e.sid) ?? { sid: e.sid, start: t, end: t, argv: [], hierarchy: "" };
    p.start = Math.min(p.start, t); p.end = Math.max(p.end, t);
    if (e.event === "start" && e.argv) p.argv = e.argv;
    if (e.event === "cmd_name" && e.hierarchy) p.hierarchy = e.hierarchy;
    byId.set(e.sid, p);
  }
  return [...byId.values()];
}
const BACKGROUND = /(^|\/)(gc|repack|prune|prune-packed|pack-objects|pack-refs|reflog|commit-graph|multi-pack-index|loose-objects|incremental-repack)$/;

let seeds = 0, failed = 0, enoent = 0, withBackground = 0, withOverlap = 0, packed = 0;
for (let k = 0; k < Number(runsArg); k++) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-probe-")), trace = join(dir + ".trace");
  process.env.GIT_TRACE2_EVENT = trace;
  seeds++;
  let err = "";
  try { await seedBoard(dir, generateBoard(1)); } catch (e) { err = String((e as Error).message ?? e).split("\n").slice(0, 4).join(" | "); }
  // Let a detached background process finish: it holds gc.pid while it runs.
  for (let w = 0; w < 100; w++) { if (await access(join(dir, ".git/gc.pid")).then(() => false, () => true)) break; await new Promise(r => setTimeout(r, 100)); }
  await new Promise(r => setTimeout(r, 300));
  const procs = processes(await readFile(trace, "utf8").catch(() => ""));
  const adds = procs.filter(p => /(^|\/)add$/.test(p.hierarchy)), bg = procs.filter(p => BACKGROUND.test(p.hierarchy));
  const overlapped = adds.filter(a => bg.some(b => b.start < a.end && a.start < b.end));
  const counts = execFileSync("git", ["count-objects", "-v"], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_TRACE2_EVENT: "" } });
  const loose = Number(/count: (\d+)/.exec(counts)?.[1]), packs = Number(/packs: (\d+)/.exec(counts)?.[1]);
  if (err) { failed++; if (/unable to create temporary file/.test(err)) enoent++; }
  if (bg.length) withBackground++;
  if (overlapped.length) withOverlap++;
  if (packs) packed++;
  console.log(JSON.stringify({ mode, k, err: err || undefined, background: [...new Set(bg.map(p => p.hierarchy))], addsOverlapped: overlapped.length, adds: adds.length, loose, packs }));
  if (detail) {
    const t0 = Math.min(...procs.map(p => p.start));
    for (const p of procs.sort((a, b) => a.start - b.start)) if (/(^|\/)(add|commit|maintenance|gc|repack|prune-packed|pack-objects)$/.test(p.hierarchy))
      console.log(`  +${((p.start - t0) / 1000).toFixed(0).padStart(6)}ms ${((p.end - p.start) / 1000).toFixed(0).padStart(5)}ms ${p.hierarchy.padEnd(34)} ${p.argv.slice(1, 4).join(" ").slice(0, 70)}`);
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(trace, { force: true });
}
console.log(JSON.stringify({ summary: mode, seeds, failed, enoent, withBackground, withOverlap, packed }));
