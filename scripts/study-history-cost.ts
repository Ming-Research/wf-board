// Temporary measurement for the study of history queries exhausting the daemon's heap (board item changes-oom-study).
// It lives only on the study branch and is deleted with it; the numbers it prints go on the board item.
//
// It builds a synthetic board of the live board's size and file sizes (git fast-import, one repository with several
// branches that share a base history), then runs each case in its own child process so heap figures do not mix:
//   open        Store.open time and the heap the open board holds
//   board       one whole-board rebuild (store.comparisonSnapshot): time and retained heap, three commits
//   clone       copying the snapshot: structuredClone time, and a Worker receiving it (time, its heap)
//   log         listing the whole history (store.log()), three times
//   changes     q.changes over the last 50 commits, on branches whose tail deletes 0, 1, 5 or 10 notes
//   old         the same on the code before the 10-15 hotfix (live roots in range walk all history)
//   worker-oom  a Worker with resourceLimits exceeding its heap: does the main thread keep running
//   parsed      heap per parsed copy of a large item (the historical-document cache holds up to 4,096)
//   diff        q.diff with a time reference (lists the whole history to resolve it)
//   unread      the page's unread steps from a cursor 500 commits back
//
// Usage: node scripts/study-history-cost.ts [--old-src <dir>]
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import v8 from "node:v8";
import { stringify, parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: {
  "old-src": { type: "string" }, cases: { type: "string" }, case: { type: "string" }, dir: { type: "string" }, src: { type: "string" }, branch: { type: "string" },
  items: { type: "string", default: "1674" }, decisions: { type: "string", default: "633" }, notes: { type: "string", default: "927" },
  history: { type: "string", default: "18000" },
} });
const ITEMS = Number(args.items), DECISIONS = Number(args.decisions), NOTES = Number(args.notes), HISTORY = Number(args.history);
const TAIL = 50, DELETIONS = [0, 1, 5, 10];
const yaml = (value: unknown) => stringify(value, { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" });
const MINUTE = 60_000, iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
// Mixed Chinese and ASCII prose, as board text is; padded to the live board's mean file sizes
// (items 14 MB / 1,674 ≈ 8.4 KB, cards 3.5 MB / 633 ≈ 5.5 KB, notes 4.0 MB / 927 ≈ 4.3 KB).
const sentence = "看板服务读历史时只读需要的文件 and keeps the cost bounded by the range. ";
const pad = (bytes: number) => sentence.repeat(Math.ceil(bytes / Buffer.byteLength(sentence)));
const heap = () => v8.getHeapStatistics().used_heap_size;
const mb = (bytes: number) => +(bytes / 1048576).toFixed(1);
const gc = () => { (globalThis as { gc?: () => void }).gc?.(); (globalThis as { gc?: () => void }).gc?.(); };

function board() {
  const projects = ["Whitefoot", "Firn", "Halo", "Snowghost", "kit", "Architect"], perProject = Math.ceil(ITEMS / projects.length);
  const start = Date.now() - (HISTORY + TAIL + 60) * 3 * MINUTE, at = iso(start);
  const ids: string[] = [], group = new Map<string, string>(), rows = new Map<string, unknown[]>(), roots: string[] = [];
  for (const [p, name] of projects.entries()) for (let j = 0; j < perProject && ids.length < ITEMS; j++) {
    const id = `p${p}-${j}`;
    ids.push(id); group.set(id, name); rows.set(id, []);
    if (j < 10) roots.push(id); else rows.get(`p${p}-${Math.floor((j - 10) / 3)}`)!.push({ id, item: id, own: true });
  }
  for (const [n, id] of ids.entries()) if (!rows.get(id)!.length) rows.get(id)!.push({ id: "w", text: "work", state: ["doing", "done", "todo"][n % 3], ...(n % 3 === 0 ? { since: at } : n % 3 === 1 ? { doneAt: at } : {}) });
  const files = new Map<string, string>(), decisions: string[] = [];
  for (let k = 0; k < DECISIONS; k++) {
    const key = `c${k}`, item = ids[(k * 7) % ids.length]!;
    decisions.push(key);
    files.set(`decisions/${key}.yaml`, yaml({ num: ITEMS + k + 1, item, question: `Question ${k}?`, background: pad(5200), options: [{ key: "A", text: "Do it", recommended: true }, { key: "B", text: "Do not" }], status: "ruled", choice: "A", ruling: "A", ruledAt: at, at, updated: at, rev: 1 }));
  }
  for (let k = 0; k < NOTES; k++) {
    const onCard = k % 2 === 0;
    files.set(`notes/n${k}.yaml`, yaml({ target: onCard ? `q:${decisions[k % decisions.length]}` : `it:${ids[(k * 5) % ids.length]}`, kind: "comment", text: pad(4000), at, state: "done", sentAt: at, reply: "Handled", repliedAt: at, repliedBy: "Firn", rev: 1 }));
  }
  const commitTime = (k: number) => start + (k + 1) * 3 * MINUTE;
  const versions = new Map<string, number>();
  const item = (id: string, version: number): string => {
    const n = ids.indexOf(id), log = Array.from({ length: version }, (_, v) => ({ at: iso(start + v * MINUTE), by: group.get(id), text: `Progress ${v} on ${id}` }));
    return yaml({ num: n + 1, title: `Item ${id}`, group: group.get(id), ...(roots.includes(id) ? { priority: "P1" } : {}),
      head: pad(7600), log, plan: [...rows.get(id)!, { id: "accept", text: "passes", state: "todo", accept: true }], created: at, updated: at, rev: version + 1 });
  };
  const write = (id: string) => { const v = (versions.get(id) ?? 0) + 1; versions.set(id, v); return item(id, v); };
  for (const id of ids) files.set(`items/${id}.yaml`, item(id, 0));
  files.set("board.yaml", yaml({ title: "Synthetic board", projects: projects.map(name => ({ name })) }));
  files.set("numbers.yaml", yaml({ next: ITEMS + DECISIONS + 1 }));
  return { ids, roots, files, start, commitTime, write };
}

async function writeRepository(dir: string): Promise<void> {
  const data = board();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const child = spawn("git", ["fast-import", "--quiet"], { cwd: dir, stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise<void>((ok, fail) => child.on("exit", code => code === 0 ? ok() : fail(new Error(`git fast-import exited ${code}`))));
  const out = (text: string) => new Promise<void>(ok => { if (child.stdin.write(text)) ok(); else child.stdin.once("drain", () => ok()); });
  const blob = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  let mark = 0;
  const commit = async (ref: string, from: number | undefined, at: number, author: string, message: string, puts: Array<[string, string]>, dels: string[] = []) => {
    const seconds = Math.floor(at / 1000);
    let text = `commit ${ref}\nmark :${++mark}\nauthor ${author} <study@wf-board.invalid> ${seconds} +0000\ncommitter wf-board <wf-board@wf-board.invalid> ${seconds} +0000\n${blob(message)}`;
    if (from) text += `from :${from}\n`;
    for (const [path, body] of puts) text += `M 100644 inline ${path}\n${blob(body)}`;
    for (const path of dels) text += `D ${path}\n`;
    await out(text);
    return mark;
  };
  let last = await commit("refs/heads/main", undefined, data.start, "Fixture", "Seed synthetic board", [...data.files]);
  for (let k = 0; k < HISTORY; k++) { const id = data.ids[k % data.ids.length]!; last = await commit("refs/heads/main", last, data.commitTime(k), "Whitefoot", `append_log ${id}`, [[`items/${id}.yaml`, data.write(id)]]); }
  const base = last;
  // Each tail: 50 commits after the shared base; five write live roots, `deletions` delete notes, the rest write owned items.
  for (const deletions of DELETIONS) {
    let from = base;
    for (let t = 0; t < TAIL; t++) {
      const at = data.commitTime(HISTORY + t), ref = `refs/heads/tail-${deletions}`;
      if (t % 10 === 3) { const id = data.roots[t / 10 | 0]!; from = await commit(ref, from, at, "Architect", `append_log ${id}`, [[`items/${id}.yaml`, data.write(id)]]); }
      else if (t % 5 === 1 && (t / 5 | 0) < deletions) { const note = `notes/n${t * 17 % NOTES}.yaml`; from = await commit(ref, from, at, "owner", `delete_note ${note}`, [], [note]); }
      else { const id = data.ids[(t * 37 + 11) % data.ids.length]!; from = await commit(ref, from, at, "Whitefoot", `append_log ${id}`, [[`items/${id}.yaml`, data.write(id)]]); }
    }
  }
  child.stdin.end();
  await done;
  execFileSync("git", ["reset", "-q", "--hard", "main"], { cwd: dir });
  for (const deletions of DELETIONS) execFileSync("git", ["worktree", "add", "-q", join(dir, "..", `tail-${deletions}`), `tail-${deletions}`], { cwd: dir });
}

/** Peak heap while `run` is pending, sampled every 10 ms, and the heap left after it once collected. */
async function measure<T>(run: () => Promise<T>): Promise<{ ms: number; peakMB: number; startMB: number; afterMB: number; value: T }> {
  gc();
  const startHeap = heap();
  let peak = startHeap;
  const timer = setInterval(() => { peak = Math.max(peak, heap()); }, 10);
  const t0 = performance.now();
  const value = await run();
  const ms = Math.round(performance.now() - t0);
  clearInterval(timer);
  peak = Math.max(peak, heap());
  gc();
  return { ms, peakMB: mb(peak - startHeap), startMB: mb(startHeap), afterMB: mb(heap() - startHeap), value };
}

async function runCase(name: string, dir: string, src: string): Promise<unknown> {
  const load = (file: string) => import(pathToFileURL(join(src, file)).href);
  const { Store } = await load("store.ts"), q = await load("query.ts");
  const opened = await measure(() => Store.open(dir));
  const store = opened.value;
  const s = store.snapshot(), git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  const result: Record<string, unknown> = { case: name, openMs: opened.ms, openHeapMB: opened.afterMB, heapAfterOpenMB: mb(heap()) };
  if (name === "board") {
    const held: unknown[] = [];
    result.boards = [];
    for (const back of [1, 200, 4000]) {
      const m = await measure(async () => { const b = await store.comparisonSnapshot(git("rev-parse", `HEAD~${back}`)); held.push(b); return b; });
      (result.boards as unknown[]).push({ back, ms: m.ms, peakMB: m.peakMB, retainedMB: m.afterMB });
    }
  } else if (name === "clone") {
    const c = await measure(async () => structuredClone(s));
    result.structuredClone = { ms: c.ms, retainedMB: c.afterMB };
    const serialized = v8.serialize(s);
    result.serializedMB = mb(serialized.length);
    const t0 = performance.now();
    const worker = new Worker(`const { parentPort } = require("node:worker_threads"); const v8 = require("node:v8");
      parentPort.on("message", m => { const n = Object.keys(m.items).length; parentPort.postMessage({ n, heap: v8.getHeapStatistics().used_heap_size }); });`, { eval: true });
    await new Promise(ok => worker.once("online", ok));
    const ready = performance.now();
    worker.postMessage(s);
    const got = await new Promise<{ n: number; heap: number }>(ok => worker.once("message", ok));
    result.worker = { startMs: Math.round(ready - t0), transferMs: Math.round(performance.now() - ready), items: got.n, workerHeapMB: mb(got.heap) };
    await worker.terminate();
  } else if (name === "log") {
    result.runs = [];
    for (let i = 0; i < 3; i++) { const m = await measure(() => store.log()); (result.runs as unknown[]).push({ ms: m.ms, peakMB: m.peakMB, commits: (m.value as unknown[]).length }); }
  } else if (name === "changes" || name === "old") {
    result.runs = [];
    const since = git("rev-parse", `HEAD~${TAIL}`);
    for (let i = 0; i < 2; i++) {
      const rebuilds = { n: 0 }, original = store.comparisonSnapshot.bind(store);
      store.comparisonSnapshot = (c: string) => { rebuilds.n++; return original(c); };
      const m = await measure(() => q.changes(store, s, since));
      store.comparisonSnapshot = original;
      const docs = (m.value as Array<{ documents: unknown[] }>).reduce((n, g) => n + g.documents.length, 0);
      (result.runs as unknown[]).push({ ms: m.ms, peakMB: m.peakMB, afterMB: m.afterMB, documents: docs, wholeBoardRebuilds: rebuilds.n });
    }
  } else if (name === "parsed") {
    // The live board's largest item file is 96 KB.
    const big = yaml({ title: "Large item", group: "Whitefoot", head: pad(60_000), log: Array.from({ length: 150 }, (_, v) => ({ at: iso(v * MINUTE), by: "Whitefoot", text: pad(200) })), plan: [{ id: "accept", text: "passes", state: "todo", accept: true }], updated: iso(0), rev: 151 });
    const copies: unknown[] = [];
    const m = await measure(async () => { for (let i = 0; i < 200; i++) copies.push(parse(big, { version: "1.2", schema: "core" })); return copies.length; });
    result.parsed = { fileKB: Math.round(Buffer.byteLength(big) / 1024), copies: 200, heapPerCopyKB: Math.round(m.afterMB * 1024 / 200), extrapolated4096MB: Math.round(m.afterMB / 200 * 4096) };
  } else if (name === "diff") {
    const id = Object.keys(s.items)[0]!, time = new Date(Date.now() - 24 * 3600_000).toISOString();
    result.runs = [];
    for (let i = 0; i < 3; i++) { const m = await measure(() => q.diff(store, "item", id, time)); (result.runs as unknown[]).push({ ms: m.ms, peakMB: m.peakMB }); }
  } else if (name === "unread") {
    const { unreadSteps } = await load("history.ts");
    const cursor = git("rev-parse", "HEAD~500");
    const m = await measure(() => unreadSteps(store, cursor, {}, s.head));
    result.unread = { ms: m.ms, peakMB: m.peakMB, afterMB: m.afterMB, steps: (m.value as unknown[]).length };
  }
  return result;
}

/** A Worker with a 256 MB heap limit allocating without bound, three ways: a tight loop, allocation between awaits
 * (as a request reading git does), and parsed YAML kept alive. Each reports whether the worker ended with an error, how
 * long that took, and how often the main thread's 10 ms timer ran meanwhile (it runs about 100 times a second when free). */
async function workerOom(): Promise<unknown> {
  const loads = {
    tight: `const a = []; for (;;) a.push(new Array(1e5).fill({ x: Math.random() }));`,
    awaiting: `const a = []; (async () => { for (;;) { for (let i = 0; i < 20; i++) a.push({ s: "x".repeat(1000) + Math.random(), n: [1, 2, 3] }); await new Promise(r => setImmediate(r)); } })();`,
    yaml: `const { parse } = require(${JSON.stringify(join(here, "../node_modules/yaml/dist/index.js"))}); const text = "head: |-\n" + "  看板服务读历史 keeps the cost bounded.\n".repeat(2000); const a = []; (async () => { for (;;) { a.push(parse(text)); await new Promise(r => setImmediate(r)); } })();`,
  };
  const out: Record<string, unknown> = { case: "worker-oom" };
  for (const [name, code] of Object.entries(loads)) {
    const worker = new Worker(code, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const t0 = performance.now();
    const progress = setInterval(() => console.error(`worker-oom ${name}: ${Math.round((performance.now() - t0) / 1000)} s, main ticks ${ticks}`), 5000);
    const ended = await Promise.race([
      new Promise<{ code?: string; message: string }>(ok => worker.once("error", e => ok({ code: (e as NodeJS.ErrnoException).code, message: e.message }))),
      new Promise<null>(ok => setTimeout(() => ok(null), 120_000)),
    ]);
    const ms = Math.round(performance.now() - t0);
    clearInterval(timer); clearInterval(progress);
    if (!ended) await worker.terminate();
    out[name] = { ended: ended ? `${ended.code}: ${ended.message}` : "no error within 120 s; terminated", ms, mainTicksPerSecond: Math.round(ticks / (ms / 1000)), mainHeapMB: mb(heap()) };
  }
  return out;
}

if (args.case) {
  const out = args.case === "worker-oom" ? await workerOom() : await runCase(args.case, resolve(args.dir!), resolve(args.src!));
  console.log(`STUDY ${JSON.stringify({ branch: args.branch, ...(out as object) })}`);
  process.exit(0);
}

console.log(`machine: ${cpus().length} CPUs (${cpus()[0]?.model}), ${mb(totalmem())} MB memory, node ${process.version}`);
const root = await mkdtemp(join(tmpdir(), "wf-board-study-"));
try {
  const dir = join(root, "main");
  execFileSync("mkdir", ["-p", dir]);
  let t0 = Date.now();
  await writeRepository(dir);
  const sizes = execFileSync("du", ["-sk", "items", "decisions", "notes"], { cwd: dir, encoding: "utf8" }).trim().replace(/\s+/g, " ");
  console.log(`board: ${ITEMS} items, ${DECISIONS} cards, ${NOTES} notes, ${HISTORY + 1} commits on main, tails of ${TAIL}; sizes (KB) ${sizes}; built in ${Date.now() - t0} ms`);
  const src = join(here, "../src");
  const child = (name: string, at: string, code: string, heapMb: number, branch: string) => new Promise<void>(ok => {
    t0 = Date.now();
    const p = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, "--expose-gc", fileURLToPath(import.meta.url), "--case", name, "--dir", at, "--src", code, "--branch", branch], { stdio: ["ignore", "pipe", "inherit"] });
    const timeout = setTimeout(() => p.kill("SIGKILL"), 15 * 60_000);
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d; });
    p.on("exit", (code, signal) => {
      clearTimeout(timeout);
      const line = out.split("\n").find(l => l.startsWith("STUDY "));
      console.log(line ?? `STUDY ${JSON.stringify({ case: name, branch, failed: true, exitCode: code, signal, heapLimitMB: heapMb, ms: Date.now() - t0 })}`);
      ok();
    });
  });
  const wanted = (name: string) => !args.cases || args.cases.split(",").includes(name);
  for (const name of ["open", "board", "clone", "log", "parsed", "diff", "unread"]) if (wanted(name)) await child(name, join(root, "tail-0"), src, 4096, "tail-0");
  if (wanted("changes")) for (const d of DELETIONS) await child("changes", join(root, `tail-${d}`), src, 4096, `tail-${d}`);
  if (wanted("worker-oom")) await child("worker-oom", root, src, 1024, "-");
  if (args["old-src"] && wanted("old")) await child("old", join(root, "tail-0"), resolve(args["old-src"]), 2048, "tail-0");
} finally {
  await rm(root, { recursive: true, force: true });
}
