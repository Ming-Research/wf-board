// History-query performance check for the board daemon: what `changes`, the unread list and `diff` cost on a board of the
// live one's size, and how far the process's heap gets while they run. It is the performance check of the board item
// that fixed `changes` running the daemon out of memory (the study's measurements were made with the script this one
// grew from), and the `bench` workflow runs it by hand on this tree and on a base commit.
//
// It builds a synthetic board like the live one in a temporary directory (1,674 items, 633 cards, 927 notes, about
// 32.7 MB of files, 18,001 commits on main) with git fast-import, plus four branches that each add 50 commits to main:
// five of them write top-level items and 0, 1, 5 or 10 delete a note. Each case runs in a child process of its own, with
// the 4 GB heap the daemon has and as a request would, under a budget (src/budget.ts) when the tree measured has one. A case
// prints a BENCH line with its time, the growth of the heap above where the case started, the highest the heap was (the
// garbage not yet collected included) against the line at which a budget stops a request (75% of the heap limit), and the
// share of the budget it read.
//
// Checks (only for the tree being measured; a run against an older tree with --report-only prints and never fails):
//   changes over the last 50 commits, any of the four branches: answers within 1 s, the heap grows by at most 100 MB
//   every case: the heap stays at or below half of the budget's line (the margin that lets a normal query pass the budget)
//   diff with a time: within 1 s
//
// Usage: node scripts/bench-changes.ts [--src <dir>] [--label <text>] [--report-only] [--cases a,b] [--history N]
//   A quick smoke run: --items 150 --decisions 60 --notes 80 --history 600
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import v8 from "node:v8";
import { stringify } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: {
  src: { type: "string", default: join(here, "../src") }, label: { type: "string", default: "this tree" }, "report-only": { type: "boolean", default: false },
  cases: { type: "string" }, case: { type: "string" }, dir: { type: "string" },
  items: { type: "string", default: "1674" }, decisions: { type: "string", default: "633" }, notes: { type: "string", default: "927" }, history: { type: "string", default: "18000" },
} });
const ITEMS = Number(args.items), DECISIONS = Number(args.decisions), NOTES = Number(args.notes), HISTORY = Number(args.history);
const TAIL = 50, DELETIONS = [0, 1, 5, 10], HEAP_MB = 4096;
const yaml = (value: unknown) => stringify(value, { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" });
const MINUTE = 60_000, iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
// Mixed Chinese and ASCII prose, as board text is; padded to the live board's mean file sizes
// (items 14 MB / 1,674 ≈ 8.4 KB, cards 3.5 MB / 633 ≈ 5.5 KB, notes 4.0 MB / 927 ≈ 4.3 KB).
const sentence = "看板服务读历史时只读需要的文件 and keeps the cost bounded by the range. ";
const pad = (bytes: number) => sentence.repeat(Math.ceil(bytes / Buffer.byteLength(sentence)));
const heap = () => v8.getHeapStatistics().used_heap_size;
const mb = (bytes: number) => +(bytes / 1048576).toFixed(1);
const gc = () => { (globalThis as { gc?: () => void }).gc?.(); (globalThis as { gc?: () => void }).gc?.(); };

/** The synthetic board: every file of the first commit, and a function writing the next version of an item. */
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
    let text = `commit ${ref}\nmark :${++mark}\nauthor ${author} <bench@wf-board.invalid> ${seconds} +0000\ncommitter wf-board <wf-board@wf-board.invalid> ${seconds} +0000\n${blob(message)}`;
    if (from) text += `from :${from}\n`;
    for (const [path, body] of puts) text += `M 100644 inline ${path}\n${blob(body)}`;
    for (const path of dels) text += `D ${path}\n`;
    await out(text);
    return mark;
  };
  let last = await commit("refs/heads/main", undefined, data.start, "Fixture", "Seed synthetic board", [...data.files]);
  for (let k = 0; k < HISTORY; k++) { const id = data.ids[k % data.ids.length]!; last = await commit("refs/heads/main", last, data.commitTime(k), "Whitefoot", `append_log ${id}`, [[`items/${id}.yaml`, data.write(id)]]); }
  const base = last;
  // Each tail: 50 commits after the shared base; five write top-level items, `deletions` delete notes, the rest write owned items.
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

interface Case { name: string; branch: string; run(ctx: Context): Promise<unknown> }
interface Context { store: any; q: any; history: any; git(...a: string[]): string }

/** The cases: a name, the branch it runs on, and the request it makes. */
const CASES: Case[] = [
  ...DELETIONS.map(deletions => ({ name: `changes-50-delete-${deletions}`, branch: `tail-${deletions}`,
    run: ({ store, q, git }: Context) => q.changes(store, store.snapshot(), git("rev-parse", `HEAD~${TAIL}`)) })),
  // About a day of the live board's writes (it had 2,431 commits in the 24 hours before the study).
  { name: "changes-2400", branch: "tail-0", run: ({ store, q, git }) => q.changes(store, store.snapshot(), git("rev-parse", `HEAD~2400`)) },
  // The same range as the last 50 commits, given as the time of the commit before them.
  { name: "changes-by-time", branch: "tail-10", run: ({ store, q, git }) => q.changes(store, store.snapshot(), git("log", "-1", "--format=%aI", `HEAD~${TAIL}`)) },
  // The page's unread list from a cursor 500 commits back, and from two days back (about 3,100 commits).
  { name: "unread-500", branch: "tail-0", run: ({ store, history, git }) => history.unreadSteps(store, git("rev-parse", "HEAD~500"), {}, store.snapshot().head) },
  { name: "unread-3100", branch: "tail-0", run: ({ store, history, git }) => history.unreadSteps(store, git("rev-parse", "HEAD~3100"), {}, store.snapshot().head) },
  { name: "diff-by-time", branch: "tail-0", run: ({ store, q }) => q.diff(store, "item", "p0-0", new Date(Date.now() - 24 * 3600_000).toISOString()) },
];

/** The heap's highest point while `run` is pending, sampled every 10 ms, and where it started once collected. */
async function measure<T>(run: () => Promise<T>): Promise<{ ms: number; startMB: number; peakUsedMB: number; growthMB: number; value: T | undefined; error?: string }> {
  gc();
  const startHeap = heap();
  let peak = startHeap;
  const timer = setInterval(() => { peak = Math.max(peak, heap()); }, 10);
  const t0 = performance.now();
  let value: T | undefined, error: string | undefined;
  try { value = await run(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  const ms = Math.round(performance.now() - t0);
  clearInterval(timer);
  peak = Math.max(peak, heap());
  return { ms, startMB: mb(startHeap), peakUsedMB: mb(peak), growthMB: mb(peak - startHeap), value, ...(error ? { error } : {}) };
}

async function runCase(name: string, dir: string, src: string): Promise<Record<string, unknown>> {
  const load = (file: string) => import(pathToFileURL(join(src, file)).href);
  const { Store } = await load("store.ts"), q = await load("query.ts"), history = await load("history.ts");
  // A tree from before the budgets has no budget module, and its requests run under none.
  const budgetModule = await load("budget.ts").catch(() => undefined);
  const opened = await measure(() => Store.open(dir));
  const store = opened.value;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  const found = CASES.find(c => c.name === name)!;
  const budget = budgetModule ? new budgetModule.Budget(name, budgetModule.REQUEST_LIMITS) : undefined;
  const request = () => found.run({ store, q, history, git });
  const m = await measure(() => budget ? budgetModule.withBudget(budget, request) : request());
  const limit = v8.getHeapStatistics().heap_size_limit, line = limit * (budgetModule ? budgetModule.REQUEST_LIMITS.heapShare : 0.75);
  const documents = Array.isArray(m.value) && m.value.every((g: { documents?: unknown[] }) => Array.isArray(g.documents)) ? m.value.reduce((n: number, g: { documents: unknown[] }) => n + g.documents.length, 0) : Array.isArray(m.value) ? m.value.length : undefined;
  const usage = budget?.usage();
  return { case: name, branch: found.branch, openMs: opened.ms, openHeapMB: mb(heap()), ms: m.ms, growthMB: m.growthMB, peakUsedMB: m.peakUsedMB, lineMB: mb(line), peakOfLine: +(m.peakUsedMB * 1048576 / line).toFixed(3),
    ...(usage ? { budgetReadMB: mb(usage.bytes), budgetAllowedMB: mb(usage.allowed), boards: usage.boards } : {}), ...(documents === undefined ? {} : { results: documents }), ...(m.error ? { error: m.error } : {}) };
}

if (args.case) {
  const out = await runCase(args.case, resolve(args.dir!), resolve(args.src!));
  console.log(`BENCH ${JSON.stringify({ label: args.label, ...out })}`);
  process.exit(0);
}

console.log(`machine: ${cpus().length} CPUs (${cpus()[0]?.model}), ${mb(totalmem())} MB memory, node ${process.version}`);
const root = await mkdtemp(join(tmpdir(), "wf-board-bench-changes-"));
const results: Array<Record<string, unknown>> = [];
try {
  const dir = join(root, "main");
  execFileSync("mkdir", ["-p", dir]);
  let t0 = Date.now();
  await writeRepository(dir);
  console.log(`bench-changes ${args.label}: ${ITEMS} items, ${DECISIONS} cards, ${NOTES} notes, ${HISTORY + 1} commits on main, tails of ${TAIL}; built in ${Date.now() - t0} ms`);
  const wanted = (name: string) => !args.cases || args.cases.split(",").includes(name);
  for (const found of CASES.filter(c => wanted(c.name))) {
    await new Promise<void>(ok => {
      t0 = Date.now();
      const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, "--expose-gc", fileURLToPath(import.meta.url), "--case", found.name, "--dir", join(root, found.branch), "--src", resolve(args.src!), "--label", args.label!], { stdio: ["ignore", "pipe", "inherit"] });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
      let output = "";
      child.stdout.on("data", (d: Buffer) => { output += d; });
      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        const line = output.split("\n").find(l => l.startsWith("BENCH "));
        const result = line ? JSON.parse(line.slice(6)) : { case: found.name, branch: found.branch, failed: true, exitCode: code, signal, ms: Date.now() - t0 };
        results.push(result);
        console.log(line ?? `BENCH ${JSON.stringify(result)}`);
        ok();
      });
    });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

// The checks.
const problems: string[] = [];
for (const r of results) {
  const name = String(r.case);
  if (r.failed || r.error) { problems.push(`${name}: ${r.failed ? `the process ended (exit ${r.exitCode}, signal ${r.signal})` : r.error}`); continue; }
  if (name.startsWith("changes-50-delete-") && (Number(r.ms) > 1000 || Number(r.growthMB) > 100)) problems.push(`${name}: ${r.ms} ms and ${r.growthMB} MB of heap growth, over the 1000 ms and 100 MB it may take`);
  if (name === "diff-by-time" && Number(r.ms) > 1000) problems.push(`${name}: ${r.ms} ms, over the 1000 ms it may take`);
  if (Number(r.peakOfLine) > 0.5) problems.push(`${name}: the heap reached ${r.peakUsedMB} MB, ${(Number(r.peakOfLine) * 100).toFixed(0)}% of the ${r.lineMB} MB line a budget stops a request at; a normal query must stay at or below half of it`);
}
console.log(problems.length ? `bench-changes ${args.label}: ${problems.length} problem(s)\n  ${problems.join("\n  ")}` : `bench-changes ${args.label}: every check passed`);
if (problems.length && !args["report-only"]) process.exitCode = 1;
