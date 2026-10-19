// Write-path performance check for the board daemon. It serves the board item that cuts the daemon's CPU per write
// (each write cost 0.28–0.4 s of CPU on the live board) and stays as that item's performance check: the `bench`
// workflow runs it by hand as a non-gating step, on this tree and on a base commit, so a regression shows as numbers.
//
// It builds a synthetic board like the live one in a temporary directory (by default 1,500 items, 600 cards, 750
// notes, 12,000 earlier commits each adding a log entry, so the activity index holds about 12,000 write times), starts
// the daemon's pieces as main.ts does (store, ops, MCP server, HTTP server with one page connected to /api/events),
// then replays set_tags writes through MCP, the path agent sessions use. It prints CPU milliseconds per write
// (process.cpuUsage, this process only; git children excluded), garbage-collection milliseconds per write, the bytes
// of each change event the page receives, and peak RSS. It also prints the characters of each project's brief on that board.
//
// Usage: node scripts/bench-writes.ts [--src <dir>] [--label <text>] [--items N] [--writes N] [--history N]
//          [--messages N] [--write set_tags|send_message|report_state]
//   --src names the src directory to measure (default: this tree's), so the same script measures older code.
//   --messages seeds N messages between agents (docs/design.md, Messages), and --write send_message replays sending
//   messages instead of set_tags: what a board holding a year of messages costs to open, to hold, to send to the page
//   (snapshot bytes, whole and as the page gets it) and per write. --write report_state replays the runner's reports (docs/design.md,
//   section 5, Runner reports), each a change of state on an item as the architect writes it: the cost of the two reports a turn.
//   --unread N puts the owner's read cursor N commits before the head, and after each write the bench asks for the unread list
//   as the open page does after every change event (GET /api/unread), so the CPU per write includes it; the replayed writes
//   are themselves changes the owner has not read, so the list grows by one stop a write. --profile records a CPU profile of
//   the replay and prints the functions with the most self time and the most total time (the profiler slows the run, so its
//   CPU numbers are not the ones to compare).
//   A quick smoke run: --items 150 --writes 50 --history 600.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PerformanceObserver } from "node:perf_hooks";
import { writeFile, mkdir } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { stringify } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: {
  src: { type: "string", default: join(here, "../src") }, label: { type: "string", default: "this tree" },
  items: { type: "string", default: "1500" }, writes: { type: "string", default: "1000" }, history: { type: "string", default: "12000" },
  decisions: { type: "string" }, notes: { type: "string" }, warmup: { type: "string", default: "20" },
  messages: { type: "string", default: "0" }, write: { type: "string", default: "set_tags" },
  unread: { type: "string" }, profile: { type: "boolean", default: false },
} });
const UNREAD = args.unread === undefined ? undefined : Number(args.unread);
const MESSAGES = Number(args.messages), WRITE = args.write!;
if (WRITE !== "set_tags" && WRITE !== "send_message" && WRITE !== "report_state") throw new Error("--write is set_tags, send_message or report_state");
const ITEMS = Number(args.items), WRITES = Number(args.writes), HISTORY = Number(args.history), WARMUP = Number(args.warmup);
const DECISIONS = Number(args.decisions ?? Math.round(ITEMS * 0.4)), NOTES = Number(args.notes ?? Math.round(ITEMS * 0.5));
const src = resolve(args.src!);
const load = (file: string) => import(pathToFileURL(join(src, file)).href);

const yaml = (value: unknown) => stringify(value, { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" });
const MINUTE = 60_000, iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

interface Profile { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }>; samples: number[]; timeDeltas: number[] }
/** Prints the functions with the most self time and the most total time per write, in milliseconds. */
function summarize(profile: Profile, writes: number): void {
  const parent = new Map<number, number>(), node = new Map(profile.nodes.map(n => [n.id, n]));
  for (const n of profile.nodes) for (const child of n.children ?? []) parent.set(child, n.id);
  const name = (id: number) => { const { functionName, url, lineNumber } = node.get(id)!.callFrame; return `${functionName || "(anonymous)"} ${url.replace(/^.*\/(src|web|node_modules)\//, "$1/")}:${lineNumber + 1}`; };
  const self = new Map<string, number>(), total = new Map<string, number>();
  for (const [k, id] of profile.samples.entries()) {
    const dt = (profile.timeDeltas[k] ?? 0) / 1000, seen = new Set<string>();
    self.set(name(id), (self.get(name(id)) ?? 0) + dt);
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) { const key = name(at); if (!seen.has(key)) { seen.add(key); total.set(key, (total.get(key) ?? 0) + dt); } }
  }
  const top = (map: Map<string, number>, n: number) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, ms]) => `    ${(ms / writes).toFixed(2).padStart(7)} ms/write  ${key}`).join("\n");
  console.log(`  profile, self time:\n${top(self, 40)}`);
  console.log(`  profile, total time:\n${top(total, 60)}`);
}

/** The synthetic board: every file of the first commit, and each later commit's one changed item file. */
function board() {
  const projects = ["Whitefoot", "Firn", "Halo", "Snowghost", "kit", "Architect"], perProject = Math.ceil(ITEMS / projects.length);
  const start = Date.now() - (HISTORY + 60) * 3 * MINUTE, at = iso(start);
  const ids: string[] = [], group = new Map<string, string>(), rows = new Map<string, unknown[]>();
  for (const [p, name] of projects.entries()) for (let j = 0; j < perProject && ids.length < ITEMS; j++) {
    const id = `p${p}-${j}`;
    ids.push(id); group.set(id, name); rows.set(id, []);
    // Ten roots per project, each owning a three-way tree.
    if (j >= 10) rows.get(`p${p}-${Math.floor((j - 10) / 3)}`)!.push({ id, item: id, own: true });
  }
  for (const [n, id] of ids.entries()) {
    const own = rows.get(id)!.length > 0, kind = n % 3;
    if (!own) rows.get(id)!.push({ id: "w", text: "work", state: ["doing", "done", "todo"][kind], ...(kind === 0 ? { since: at } : kind === 1 ? { doneAt: at } : {}) });
    // A shared row into another project for one item in twenty.
    if (n % 20 === 7) { const target = ids[(n * 7 + 13) % ids.length]!; if (target !== id && group.get(target) !== group.get(id)) rows.get(id)!.push({ id: target, item: target, own: false }); }
  }
  const files = new Map<string, string>(), decisions: string[] = [], placed = new Map(ids.map(id => [id, [] as string[]]));
  for (let k = 0; k < DECISIONS; k++) {
    const key = `c${k}`, item = ids[(k * 7) % ids.length]!, open = k % 3 !== 0;
    decisions.push(key);
    files.set(`decisions/${key}.yaml`, yaml({ num: ITEMS + k + 1, item, question: `Question ${k}?`, options: [{ key: "A", text: "Do it", recommended: true }, { key: "B", text: "Do not" }],
      status: open ? "open" : "ruled", ...(open && k % 5 === 0 ? { blocks: "work stops" } : {}), ...(open ? {} : { choice: "A", ruledAt: at }), at, updated: at, rev: 1 }));
    // The head places every card on a line of its own, as the converted board does. Only a card that blocks has a row in
    // its item's plan, and so do some closed cards, which keep the row they had.
    placed.get(item)!.push(`[[q:${key}]]`);
    if (open ? k % 5 === 0 : k % 2 === 0) rows.get(item)!.push({ id: key, card: key });
  }
  for (let k = 0; k < NOTES; k++) {
    const onCard = k % 2 === 0 && decisions.length > 0, done = k % 3 === 0;
    files.set(`notes/n${k}.yaml`, yaml({ target: onCard ? `q:${decisions[k % decisions.length]}` : `it:${ids[(k * 5) % ids.length]}`, kind: onCard ? "choice" : "comment", ...(onCard ? { choice: "A" } : {}),
      text: `Note ${k}`, at, state: done ? "done" : "sent", sentAt: at, ...(done ? { reply: "Handled", repliedAt: at, repliedBy: "Firn" } : {}), rev: 1 }));
  }
  // Messages as agents write them, 140 a day before the history starts: a sentence naming an item, from an engineer to the
  // architect, one file per UTC day (docs/design.md, Messages).
  const days = new Map<string, unknown[]>();
  for (let k = 0; k < MESSAGES; k++) {
    const id = ids[(k * 3) % ids.length]!, time = iso(start - (MESSAGES - k) * Math.floor(86_400_000 / 140));
    const list = days.get(time.slice(0, 10)) ?? [];
    list.push({ id: `${time.replace(/[-:]/g, "")}-${(k % 65536).toString(16).padStart(4, "0")}`, from: `eng-${id}`, project: group.get(id), to: "架构师", text: `${id} 的 PR 可以看了：读条目日志最后一条，等你验收，审查的发现都改了`, item: id, at: time });
    days.set(time.slice(0, 10), list);
  }
  for (const [day, messages] of days) files.set(`messages/${day}.yaml`, yaml({ messages, rev: 1 }));
  const commitTime = (k: number) => start + (k + 1) * 3 * MINUTE;
  // Item `n` is written by history commits n, n + ITEMS, ...; version v carries the log entries of its first v + 1 writes.
  const item = (n: number, versions: number): string => {
    const id = ids[n]!, log = Array.from({ length: versions }, (_, v) => ({ at: iso(commitTime(n + v * ITEMS)), by: group.get(id), text: `Progress ${v} on ${id}` }));
    return yaml({ num: n + 1, title: `Item ${id}`, group: group.get(id),
      head: ["A synthetic head with a little text.", ...placed.get(id)!].join("\n\n"), log, plan: [...rows.get(id)!, { id: "accept", text: "passes", state: "todo", accept: true }], created: at,
      updated: versions ? log.at(-1)!.at : at, rev: versions + 1 });
  };
  for (let n = 0; n < ids.length; n++) files.set(`items/${ids[n]}.yaml`, item(n, 0));
  files.set("board.yaml", yaml({ title: "Synthetic board", projects: projects.map(name => ({ name })), tags: [{ name: "健全性", meaning: "改动影响程序是否被正确接受" }, { name: "报错信息", meaning: "改动影响诊断措辞" }] }));
  files.set("numbers.yaml", yaml({ next: ITEMS + DECISIONS + 1 }));
  return { ids, group, files, start, history: (k: number) => ({ path: `items/${ids[k % ids.length]}.yaml`, text: item(k % ids.length, Math.floor(k / ids.length) + 1), at: commitTime(k), id: ids[k % ids.length]! }) };
}

/** One git fast-import run writes the first commit and the whole history in seconds. */
async function writeRepository(dir: string, data: ReturnType<typeof board>): Promise<void> {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const child = spawn("git", ["fast-import", "--quiet"], { cwd: dir, stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise<void>((ok, fail) => child.on("exit", code => code === 0 ? ok() : fail(new Error(`git fast-import exited ${code}`))));
  const write = (text: string) => new Promise<void>(ok => { if (child.stdin.write(text)) ok(); else child.stdin.once("drain", () => ok()); });
  const blob = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  const commit = async (mark: number, at: number, author: string, message: string, files: Array<[string, string]>) => {
    const seconds = Math.floor(at / 1000);
    let out = `commit refs/heads/main\nmark :${mark}\nauthor ${author} <bench@wf-board.invalid> ${seconds} +0000\ncommitter wf-board <wf-board@wf-board.invalid> ${seconds} +0000\n${blob(message)}`;
    if (mark > 1) out += `from :${mark - 1}\n`;
    for (const [path, text] of files) out += `M 100644 inline ${path}\n${blob(text)}`;
    await write(out);
  };
  await commit(1, data.start, "Fixture", "Seed synthetic board", [...data.files]);
  for (let k = 0; k < HISTORY; k++) { const h = data.history(k); await commit(k + 2, h.at, "Whitefoot", `append_log ${h.id}`, [[h.path, h.text]]); }
  child.stdin.end();
  await done;
  execFileSync("git", ["reset", "-q", "--hard", "main"], { cwd: dir });
}

const dir = await mkdtemp(join(tmpdir(), "wf-board-bench-"));
try {
  const data = board();
  let t0 = Date.now();
  await writeRepository(dir, data);
  const built = Date.now() - t0;
  // The owner's cursor, kept in the working tree as the store keeps it between commits.
  if (UNREAD !== undefined) {
    const cursor = execFileSync("git", ["rev-parse", `HEAD~${UNREAD}`], { cwd: dir, encoding: "utf8" }).trim();
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state/owner.yaml"), yaml({ cursor }));
  }
  const { Store } = await load("store.ts"), { ops } = await load("ops.ts"), { createMcpServer } = await load("mcp.ts");
  const { createHttpServer } = await load("http.ts"), { ownerOps } = await load("owner-ops.ts");
  t0 = Date.now();
  const store = await Store.open(dir);
  const opened = Date.now() - t0, op = ops(store);
  // The size of each project's brief, which an agent reads at the start of a session: the status-shows-progress change must not grow it.
  const { brief } = await load("query.ts"), { rules } = await load("rules.ts"), start = store.snapshot(), derived = rules(start);
  const briefChars: Record<string, number> = Object.fromEntries(start.board.projects.map((p: { name: string }) => [p.name, JSON.stringify(brief(start, derived, p.name)).length]));
  const server: http.Server = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: join(src, "../web"), createMcp: () => createMcpServer({ store, ops: op }) });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  // The page's event stream: bytes and change events received.
  let bytes = 0, events = 0, tail = "";
  const stream = await new Promise<http.IncomingMessage>(ok => http.get({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}` } }, ok));
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    // The tail is one byte shorter than the marker, so a marker split across chunks counts once.
    const text = tail + chunk.toString("latin1");
    events += text.split("event: change\n").length - 1;
    tail = text.slice(-13);
  });
  const mcp = createMcpServer({ store, ops: op }), client = new Client({ name: "bench", version: "1" });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide); await client.connect(clientSide);
  const write = async (n: number) => {
    const id = data.ids[n % data.ids.length]!;
    const result = WRITE === "send_message"
      ? await client.callTool({ name: "send_message", arguments: { author: data.group.get(id), session: `eng-${id}`, to: "架构师", text: `${id} 的 PR 可以看了，等你验收`, item: id } })
      : WRITE === "report_state"
      // Alternating states with a growing cost, so every report changes the item and none is skipped as a repeat.
      ? await client.callTool({ name: "report_state", arguments: { author: "Architect", session: "架构师", id, state: n % 2 ? "running" : "ci", turns: n, cost: n / 100, note: `第 ${n} 轮` } })
      : await client.callTool({ name: "set_tags", arguments: { author: data.group.get(id), id, tags: [n % 2 ? "健全性" : "报错信息"] } });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    if (UNREAD !== undefined) await unread();
  };
  // What the page asks for after each change event; the body is read whole and not parsed.
  let unreadBytes = 0, unreadSteps = 0;
  const unread = () => new Promise<void>((ok, fail) => http.get({ host: "127.0.0.1", port, path: "/api/unread", headers: { host: `127.0.0.1:${port}` } }, res => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => {
      const body = Buffer.concat(chunks);
      if (res.statusCode !== 200) { fail(new Error(`GET /api/unread ${res.statusCode}: ${body.toString().slice(0, 300)}`)); return; }
      unreadBytes = body.length; unreadSteps = body.toString().split('"commits":').length - 1; ok();
    });
  }).on("error", fail));
  if (UNREAD !== undefined) { t0 = Date.now(); await unread(); console.log(`  first unread list over ${UNREAD} commits: ${Date.now() - t0} ms, ${unreadSteps} stops`); }
  for (let n = 0; n < WARMUP; n++) await write(n);
  await new Promise(ok => setTimeout(ok, 200));
  const bytesBefore = bytes, eventsBefore = events;
  let gc = 0;
  const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) gc += entry.duration; });
  observer.observe({ entryTypes: ["gc"] });
  const session = args.profile ? new Session() : undefined;
  if (session) { session.connect(); await session.post("Profiler.enable"); await session.post("Profiler.setSamplingInterval", { interval: 250 }); await session.post("Profiler.start"); }
  const cpu = process.cpuUsage();
  t0 = Date.now();
  for (let n = WARMUP; n < WARMUP + WRITES; n++) await write(n);
  const wall = Date.now() - t0, used = process.cpuUsage(cpu);
  if (session) { const { profile } = await session.post("Profiler.stop"); session.disconnect(); summarize(profile as unknown as Profile, WRITES); }
  for (let wait = 0; events - eventsBefore < WRITES && wait < 100; wait++) await new Promise(ok => setTimeout(ok, 100));
  observer.disconnect();
  const result = {
    label: args.label, items: data.ids.length, decisions: DECISIONS, notes: NOTES, history: HISTORY, activityWrites: store.snapshot().activity?.writes.length ?? 0, writes: WRITES,
    cpuMsPerWrite: +((used.user + used.system) / 1000 / WRITES).toFixed(1), userMsPerWrite: +(used.user / 1000 / WRITES).toFixed(1), systemMsPerWrite: +(used.system / 1000 / WRITES).toFixed(1),
    gcMsPerWrite: +(gc / WRITES).toFixed(1), wallMsPerWrite: +(wall / WRITES).toFixed(1),
    eventBytesPerChange: Math.round((bytes - bytesBefore) / Math.max(1, events - eventsBefore)), changeEvents: events - eventsBefore,
    peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024), buildMs: built, openMs: opened, briefChars,
    ...(UNREAD === undefined ? {} : { unread: UNREAD, unreadStops: unreadSteps, unreadBytes }),
    messages: Object.values(store.snapshot().messages ?? {}).reduce((n: number, day) => n + (day as { messages: unknown[] }).messages.length, 0), write: WRITE,
    snapshotBytes: JSON.stringify(store.snapshot()).length,
    // What GET /api/snapshot sends the page; code from before messages has no such function and sends the snapshot whole.
    pageSnapshotBytes: JSON.stringify((await load("http.ts")).pageSnapshot?.(store.snapshot()) ?? store.snapshot()).length,
  };
  console.log(`bench-writes ${result.label}: ${result.items} items, ${result.decisions} cards, ${result.notes} notes, ${result.messages} messages, ${result.activityWrites} activity writes, ${WRITES} ${WRITE} writes`);
  console.log(`  CPU ms/write ${result.cpuMsPerWrite} (user ${result.userMsPerWrite}, system ${result.systemMsPerWrite}); GC ms/write ${result.gcMsPerWrite}; wall ms/write ${result.wallMsPerWrite}`);
  console.log(`  event bytes/change ${result.eventBytesPerChange} over ${result.changeEvents} events; peak RSS ${result.peakRssMB} MB; build ${built} ms, open ${opened} ms`);
  if (UNREAD !== undefined) console.log(`  unread list after the replay: ${unreadSteps} stops, ${unreadBytes} bytes`);
  console.log(`  snapshot ${result.snapshotBytes} bytes, as the page gets it ${result.pageSnapshotBytes} bytes`);
  console.log(`  brief characters per project: ${Object.entries(briefChars).map(([name, n]) => `${name} ${n}`).join(", ")}; total ${Object.values(briefChars).reduce((a, b) => a + b, 0)}`);
  console.log(`BENCH ${JSON.stringify(result)}`);
  await client.close(); await mcp.close(); stream.destroy();
  await new Promise<void>(ok => server.close(() => ok()));
} finally {
  await rm(dir, { recursive: true, force: true });
}
