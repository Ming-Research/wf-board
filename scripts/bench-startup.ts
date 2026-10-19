// Start-up scan benchmark for the board daemon: what a start with no usable startup cache (the first start after the cache's
// format changes, or after its file is lost) costs in each step, at several sizes of the same history. It is the performance
// check of the board item that made the replay of pause intervals grow with the commits instead of with the commits times the
// size of the board (the 10-19 scan of the live board took 69.4 s, 57.3 s of them in the replay of pauses, and a deploy rolls
// back when the daemon is not healthy after 90 s), and the `bench` workflow runs it by hand on this tree and on a base commit.
//
// It builds a synthetic history shaped like the live one's (1,965 items of about 10 KB at 34,651 commits on 2026-10-19; the
// mix of writes is the live board's, read from the commit messages: appended log entries, plan edits, head edits, runner
// reports, moves, new items, and pauses set and cleared), with git fast-import. Items are created evenly over the history, and the
// first pause comes a third of the way in, as the live one's did, so a history cut at a half has half of the items. Each size is
// the history cut at that many commits, opened by a child process of its own with no startup cache, and reports the steps
// the start prints (read git log, replay activity, replay pauses) and a digest of the activity index, so a change of the replay
// can be shown to derive the same index.
//
// Checks (only for the tree being measured; a run against an older tree with --report-only prints and never fails):
//   the replay of pauses of the largest size takes at most 10 s
//   from one size to the next one up (double the commits) it takes at most 2.5 times as long, which a replay that grows with the
//   commits times the size of the board does not keep
//
// Usage: node scripts/bench-startup.ts [--src <dir>] [--label <text>] [--report-only] [--commits 35000] [--steps 3]
//   A quick smoke run: --commits 2000
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { stringify } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: {
  src: { type: "string", default: join(here, "../src") }, label: { type: "string", default: "this tree" }, "report-only": { type: "boolean", default: false },
  commits: { type: "string", default: "35000" }, steps: { type: "string", default: "3" }, case: { type: "string" }, dir: { type: "string" },
} });
const COMMITS = Number(args.commits), STEPS = Number(args.steps);
// The live board had 1,965 items at 34,651 commits.
const ITEMS_PER_COMMIT = 1965 / 34651, HEAP_MB = 4096, MINUTE = 60_000;
const PROJECTS = ["Whitefoot", "Firn", "Halo", "Snowghost", "kit", "Architect"];
const yaml = (value: unknown) => stringify(value, { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" });
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const sentence = "看板服务读历史时只读需要的文件 and keeps the cost bounded by the range. ";
const pad = (bytes: number) => sentence.repeat(Math.ceil(bytes / Buffer.byteLength(sentence)));

/** A small seeded generator, so every run builds the same history. */
function random(seed: number): () => number {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface SyntheticItem { num: number; title: string; group: string; head: string; log: unknown[]; plan: unknown[]; paused?: { reason: string; at: string }; runner?: unknown; links: []; created: string; updated: string; rev: number }
interface Step { message: string; session?: string; puts: Array<[string, string]> }

/** The history as a list of steps (a commit each): the seed first, then the writes. */
function* history(total: number): Generator<Step & { at: number }> {
  const rnd = random(20261019), start = Date.now() - total * MINUTE;
  const finalItems = Math.max(20, Math.round(total * ITEMS_PER_COMMIT));
  const items = new Map<string, SyntheticItem>(), parent = new Map<string, string>();
  const ids: string[] = [];
  const pick = <T>(list: T[]): T => list[Math.floor(rnd() * list.length)]!;
  const path = (id: string) => `items/${id}.yaml`;
  const put = (id: string): [string, string] => [path(id), yaml(items.get(id))];
  const ownRows = (it: SyntheticItem) => it.plan.filter(row => (row as { own?: boolean }).own) as Array<{ item: string }>;
  const touch = (id: string, at: number): SyntheticItem => { const it = items.get(id)!; it.rev++; it.updated = iso(at); return it; };
  const create = (at: number, owner?: string): string[] => {
    const id = `i${ids.length}`, group = owner ? items.get(owner)!.group : PROJECTS[ids.length % PROJECTS.length]!;
    ids.push(id);
    items.set(id, { num: ids.length, title: `Item ${id}`, group, head: pad(2000 + (ids.length * 977) % 6000), log: [], links: [], created: iso(at), updated: iso(at), rev: 1,
      plan: [{ id: "w", text: "work", state: "todo" }, { id: "accept", text: "passes", state: "todo", accept: true }] });
    if (owner) { parent.set(id, owner); touch(owner, at).plan.unshift({ id, item: id, own: true }); }
    return owner ? [id, owner] : [id];
  };
  const isUnder = (id: string, ancestor: string): boolean => { for (let p: string | undefined = id; p; p = parent.get(p)) if (p === ancestor) return true; return false; };
  const ownerCandidate = (group?: string): string | undefined => { const list = ids.filter(id => (!group || items.get(id)!.group === group) && ownRows(items.get(id)!).length < 6); return list.length ? pick(list) : undefined; };
  // Created over the history evenly, a quarter of them in the seed (the live board's import).
  const seedItems = Math.round(finalItems / 4);
  const seed: Array<[string, string]> = [];
  const roots = Math.min(24, Math.ceil(seedItems / 4));
  for (let k = 0; k < seedItems; k++) for (const id of create(start, k < roots ? undefined : ownerCandidate())) seed.push(put(id));
  yield { message: "Seed synthetic board", puts: [["board.yaml", yaml({ title: "Synthetic board", projects: PROJECTS.map(name => ({ name })) })], ["numbers.yaml", yaml({ next: finalItems + 1 })], ...new Map(seed).entries()], at: start };
  const paused: string[] = [];
  for (let k = 1; k < total; k++) {
    const at = start + k * MINUTE, session = rnd() < 0.7 ? `eng-${Math.floor(rnd() * 8)}` : undefined;
    const due = seedItems + Math.floor((finalItems - seedItems) * k / total);
    let message: string, touched: string[];
    const roll = rnd();
    if (ids.length < due) {
      const owner = rnd() < 0.9 ? ownerCandidate() : undefined;
      touched = create(at, owner);
      message = `create_item ${touched[0]}`;
    } else if (k === Math.floor(total / 3) || (roll < 0.005 && k > total / 3)) {
      // A pause set or cleared (the live board had 172 such writes among 34,651 commits); the first a third of the way in.
      if (paused.length && (rnd() < 0.5 || paused.length >= 12)) { const id = paused.splice(Math.floor(rnd() * paused.length), 1)[0]!; delete touch(id, at).paused; touched = [id]; message = `set_pause ${id} resumed`; }
      else { const id = pick(ids.filter(i => !paused.includes(i) && ownRows(items.get(i)!).length > 0)); touch(id, at).paused = { reason: "Waiting for the owner", at: iso(at) }; paused.push(id); touched = [id]; message = `set_pause ${id} paused`; }
    } else if (roll < 0.045) {
      // move_item: an item goes under another owner of its project (or an area becomes owned), an owned row leaves the old owner's plan.
      const id = pick(ids.filter(i => parent.has(i))), old = parent.get(id)!, to = ownerCandidate(items.get(id)!.group);
      if (to && to !== old && !isUnder(to, id)) {
        const from = touch(old, at); from.plan = from.plan.filter(row => !((row as { own?: boolean }).own && (row as { item: string }).item === id));
        touch(to, at).plan.unshift({ id, item: id, own: true });
        parent.set(id, to); touched = [old, to]; message = `move_item ${id}`;
      } else { const it = touch(id, at); it.log.push({ at: iso(at), by: it.group, text: `Progress on ${id}` }); touched = [id]; message = `append_log ${id}`; }
    } else if (roll < 0.09) {
      const id = pick(ids); touch(id, at).runner = { state: "running", since: iso(at), at: iso(at), started: iso(start), turns: k % 50 };
      touched = [id]; message = `report_state ${id} running`;
    } else if (roll < 0.30) {
      // set_plan: a row changes state (not the ownership), or the plan gains a row.
      const id = pick(ids), it = touch(id, at), row = it.plan.find(r => (r as { id: string }).id === "w") as { state: string } | undefined;
      if (row) row.state = row.state === "todo" ? "doing" : "todo";
      touched = [id]; message = `set_plan ${id}`;
    } else if (roll < 0.52) {
      const id = pick(ids), it = touch(id, at); it.head = pad(2000 + ((k + it.num) * 977) % 6000);
      touched = [id]; message = `update_item ${id}`;
    } else {
      const id = pick(ids), it = touch(id, at); it.log.push({ at: iso(at), by: it.group, text: `Progress ${it.log.length} on ${id}: ${pad(120)}` });
      touched = [id]; message = `append_log ${id}`;
    }
    yield { message, ...(session ? { session } : {}), puts: touched.map(put), at };
  }
}

async function writeRepository(dir: string, sizes: number[]): Promise<void> {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const child = spawn("git", ["fast-import", "--quiet"], { cwd: dir, stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise<void>((ok, fail) => child.on("exit", code => code === 0 ? ok() : fail(new Error(`git fast-import exited ${code}`))));
  const out = (text: string) => new Promise<void>(ok => { if (child.stdin.write(text)) ok(); else child.stdin.once("drain", () => ok()); });
  const blob = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  let mark = 0, last: number | undefined, count = 0;
  for (const step of history(sizes.at(-1)!)) {
    const seconds = Math.floor(step.at / 1000);
    let text = `commit refs/heads/main\nmark :${++mark}\nauthor Whitefoot <bench@wf-board.invalid> ${seconds} +0000\ncommitter wf-board <wf-board@wf-board.invalid> ${seconds} +0000\n${blob(step.message + (step.session ? `\n\nSession: ${step.session}` : ""))}`;
    if (last) text += `from :${last}\n`;
    for (const [file, body] of step.puts) text += `M 100644 inline ${file}\n${blob(body)}`;
    await out(text);
    last = mark; count++;
    if (sizes.includes(count) && count !== sizes.at(-1)) await out(`reset refs/heads/size-${count}\nfrom :${mark}\n\n`);
  }
  child.stdin.end();
  await done;
  execFileSync("git", ["reset", "-q", "--hard", "main"], { cwd: dir });
  for (const size of sizes.slice(0, -1)) execFileSync("git", ["worktree", "add", "-q", join(dir, "..", `size-${size}`), `size-${size}`], { cwd: dir });
}

/** One size in a process of its own: open the store with no startup cache and report the steps and a digest of the index. */
async function runCase(dir: string, src: string): Promise<Record<string, unknown>> {
  const { Store } = await import(pathToFileURL(join(src, "store.ts")).href);
  const steps: Record<string, number> = {};
  const t0 = performance.now();
  const store = await Store.open(dir, { startup: (step: string, ms: number) => { steps[step] = Math.round((steps[step] ?? 0) + ms); } });
  const total = Math.round(performance.now() - t0);
  const activity = store.snapshot().activity;
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  const pauses = Object.entries(activity?.pauses ?? {}).sort(([a], [b]) => a < b ? -1 : 1);
  return { total, steps, items: Object.keys(store.snapshot().items).length, pauseItems: pauses.length, pauseSpans: pauses.reduce((n, [, spans]) => n + (spans as unknown[]).length, 0),
    pausesDigest: digest(pauses), activityDigest: digest({ ...activity, pauses: undefined }) };
}

if (args.case) {
  console.log(`BENCH ${JSON.stringify({ label: args.label, commits: Number(args.case), ...await runCase(resolve(args.dir!), resolve(args.src!)) })}`);
  process.exit(0);
}

const sizes = Array.from({ length: STEPS }, (_, i) => Math.round(COMMITS / 2 ** (STEPS - 1 - i)));
console.log(`machine: ${cpus().length} CPUs (${cpus()[0]?.model}), ${Math.round(totalmem() / 1048576)} MB memory, node ${process.version}`);
const root = await mkdtemp(join(tmpdir(), "wf-board-bench-startup-"));
const results: Array<Record<string, any>> = [];
try {
  const main = join(root, "main");
  execFileSync("mkdir", ["-p", main]);
  let t0 = Date.now();
  await writeRepository(main, sizes);
  console.log(`bench-startup ${args.label}: sizes ${sizes.join(", ")} commits; built in ${Date.now() - t0} ms`);
  for (const size of sizes) {
    await new Promise<void>(ok => {
      t0 = Date.now();
      const dir = size === sizes.at(-1) ? main : join(root, `size-${size}`);
      const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, fileURLToPath(import.meta.url), "--case", String(size), "--dir", dir, "--src", resolve(args.src!), "--label", args.label!], { stdio: ["ignore", "pipe", "inherit"] });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
      let output = "";
      child.stdout.on("data", (d: Buffer) => { output += d; });
      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        const line = output.split("\n").find(l => l.startsWith("BENCH "));
        const result = line ? JSON.parse(line.slice(6)) : { commits: size, failed: true, exitCode: code, signal, ms: Date.now() - t0 };
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
for (const r of results) if (r.failed) problems.push(`${r.commits} commits: the process ended (exit ${r.exitCode}, signal ${r.signal})`);
const replay = (r: Record<string, any>): number | undefined => r.steps?.["replay pauses"];
const done = results.filter(r => !r.failed && replay(r) !== undefined);
const largest = done.at(-1);
if (largest && replay(largest)! > 10_000) problems.push(`${largest.commits} commits: the replay of pauses took ${replay(largest)} ms, over the 10000 ms it may take`);
for (let i = 1; i < done.length; i++) {
  const ratio = replay(done[i]!)! / Math.max(1, replay(done[i - 1]!)!);
  console.log(`bench-startup ${args.label}: replay of pauses ${done[i - 1]!.commits} -> ${done[i]!.commits} commits: x${ratio.toFixed(2)}`);
  if (ratio > 2.5) problems.push(`${done[i]!.commits} commits: the replay of pauses took ${ratio.toFixed(2)} times as long as at ${done[i - 1]!.commits}, over the 2.5 times it may take for double the commits`);
}
console.log(problems.length ? `bench-startup ${args.label}: ${problems.length} problem(s)\n  ${problems.join("\n  ")}` : `bench-startup ${args.label}: every check passed`);
if (problems.length && !args["report-only"]) process.exitCode = 1;
