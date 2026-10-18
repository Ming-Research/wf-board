// Temporary probe for board item board-rearch-study (deleted with its branch): what one write and the history reads cost
// when the board's history is git commits, as the store keeps it now, and when it is rows of an SQLite log.
//
// It builds one synthetic board like the live one (about 1,800 items averaging 8 KB, cards and notes, a history of
// 20,000 commits that each append a log line, half of them to a few hot items) twice: as a git repository written with
// fast-import, and as an SQLite file (node:sqlite, WAL, synchronous FULL) holding every version and one event per write.
// Then, in interleaved blocks (git, SQLite, git again as the twin that measures the noise), it times writes made the
// way each store makes them: the four git commands of Store.commit, or one SQLite transaction. Last it times the two
// history reads the board makes most: the versions of one item (the repeated-write check's `git log -n 20 -- <file>`,
// also with the commit-graph's changed-path filters) and what changed over the last 2,400 commits.
//
// Usage: node scripts/probe-store.ts [--items N] [--history N] [--blocks N] [--per-block N]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { deflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { stringify } from "yaml";

const { values: args } = parseArgs({ options: {
  items: { type: "string", default: "1800" }, history: { type: "string", default: "20000" },
  blocks: { type: "string", default: "12" }, "per-block": { type: "string", default: "25" },
} });
const ITEMS = Number(args.items), HISTORY = Number(args.history), BLOCKS = Number(args.blocks), PER_BLOCK = Number(args["per-block"]);
const CARDS = Math.round(ITEMS * 0.44), NOTES = Math.round(ITEMS * 0.63);

// A fixed pseudo-random sequence, so every run builds the same board.
let state = 42;
const rand = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const yaml = (value: unknown) => stringify(value, { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" });
const words = "看板 条目 计划 验收 推送 会话 工程师 审查 合入 设计 the board item plan review merge design session push".split(" ");
const prose = (chars: number) => { let s = ""; while (s.length < chars) s += words[Math.floor(rand() * words.length)] + (rand() < 0.1 ? "。\n" : " "); return s; };
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const T0 = Date.UTC(2026, 9, 11);

const ids = Array.from({ length: ITEMS }, (_, n) => `item-${n}`);
// Heads from 300 characters to about 40 K, so the files average about 8 KB as the live board's do (14.7 MB over 1,824).
const heads = ids.map(() => prose(Math.round(300 + 9000 * rand() ** 2.2)));
const logs: Array<Array<{ at: string; by: string; text: string }>> = ids.map(() => []);
const itemDoc = (n: number, rev: number) => yaml({ num: n + 1, title: `Item ${n}`, group: "wf-board", head: heads[n], plan: [{ id: "w", text: "work", state: "doing" }, { id: "accept", text: "passes", state: "todo", accept: true }], log: logs[n], created: iso(T0), updated: logs[n]!.at(-1)?.at ?? iso(T0), rev });
const revs = ids.map(() => 1);
// Half the history goes to 90 hot items, the rest spread over all, so most items have fewer than 20 commits.
const target = () => rand() < 0.5 ? Math.floor(rand() * 90) : Math.floor(rand() * ITEMS);

const root = mkdtempSync(join(tmpdir(), "probe-store-")), repo = join(root, "repo"), dbFile = join(root, "board.db");
mkdirSync(repo);
const git = (argv: string[], input?: string) => {
  const r = spawnSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...argv], { cwd: repo, input, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
const quantile = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const median = (a: number[]) => quantile(a, 0.5);

// The initial documents and the history, written to both stores.
const initial: Array<[string, string]> = ids.map((id, n) => [`items/${id}.yaml`, itemDoc(n, 1)]);
for (let k = 0; k < CARDS; k++) initial.push([`decisions/c${k}.yaml`, yaml({ item: ids[k % ITEMS], question: prose(80), options: [{ key: "A", text: prose(40), detail: prose(600) }, { key: "B", text: prose(40), detail: prose(400) }], status: "ruled", rev: 1 })]);
for (let k = 0; k < NOTES; k++) initial.push([`notes/n${k}.yaml`, yaml({ target: `it:${ids[(k * 5) % ITEMS]}`, kind: "comment", text: prose(300), state: "done", rev: 1 })]);
const history: Array<{ n: number; at: string; text: string }> = [];
for (let k = 0; k < HISTORY; k++) {
  const n = target(), at = iso(T0 + (k + 1) * 30_000);
  logs[n]!.push({ at, by: "wf-board", text: prose(200) });
  history.push({ n, at, text: itemDoc(n, ++revs[n]!) });
}

// Git, as the store keeps it: one commit per write, written here with fast-import.
let t = process.hrtime.bigint();
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
const blob = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
let stream = `commit refs/heads/main\nmark :1\ncommitter wf-board <w@x.invalid> ${Math.floor(T0 / 1000)} +0000\n${blob("seed")}`;
for (const [path, text] of initial) stream += `M 100644 inline ${path}\n${blob(text)}`;
const chunks = [stream];
history.forEach((h, k) => chunks.push(`commit refs/heads/main\nmark :${k + 2}\ncommitter wf-board <w@x.invalid> ${Math.floor(Date.parse(h.at) / 1000)} +0000\n${blob(`append_log ${ids[h.n]}\n\nSession: s${k % 40}`)}from :${k + 1}\nM 100644 inline items/${ids[h.n]}.yaml\n${blob(h.text)}`));
const child = spawn("git", ["fast-import", "--quiet"], { cwd: repo, stdio: ["pipe", "inherit", "inherit"] });
for (const c of chunks) if (!child.stdin.write(c)) await new Promise(ok => child.stdin.once("drain", ok));
child.stdin.end();
await new Promise<void>((ok, fail) => child.on("exit", code => code === 0 ? ok() : fail(new Error(`fast-import ${code}`))));
git(["reset", "-q", "--hard", "main"]);
git(["repack", "-a", "-d", "-q"]);
git(["commit-graph", "write", "--reachable", "--split", "--no-progress"]);
const gitBuild = ms(t);

// SQLite: every version of every document, compressed, and one event row per write.
t = process.hrtime.bigint();
const db = new DatabaseSync(dbFile);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
  CREATE TABLE events(seq INTEGER PRIMARY KEY, at TEXT NOT NULL, author TEXT NOT NULL, session TEXT, request TEXT UNIQUE, op TEXT NOT NULL);
  CREATE TABLE versions(seq INTEGER NOT NULL, path TEXT NOT NULL, rev INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(path, rev)) WITHOUT ROWID;
  CREATE INDEX versions_by_seq ON versions(seq, path);
  CREATE TABLE docs(path TEXT PRIMARY KEY, rev INTEGER NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL) WITHOUT ROWID;`);
const insEvent = db.prepare("INSERT INTO events(seq, at, author, session, request, op) VALUES (?, ?, ?, ?, ?, ?)");
const insVersion = db.prepare("INSERT INTO versions(seq, path, rev, body) VALUES (?, ?, ?, ?)");
const putDoc = db.prepare("INSERT INTO docs(path, rev, seq, body) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET rev = excluded.rev, seq = excluded.seq, body = excluded.body");
db.exec("BEGIN");
insEvent.run(1, iso(T0), "fixture", null, null, "seed");
for (const [path, text] of initial) { insVersion.run(1, path, 1, deflateRawSync(text)); putDoc.run(path, 1, 1, text); }
const dbRevs = ids.map(() => 1);
history.forEach((h, k) => {
  const path = `items/${ids[h.n]}.yaml`, rev = ++dbRevs[h.n]!;
  insEvent.run(k + 2, h.at, "wf-board", `s${k % 40}`, `r${k}`, `append_log ${ids[h.n]}`);
  insVersion.run(k + 2, path, rev, deflateRawSync(h.text)); putDoc.run(path, rev, k + 2, h.text);
});
db.exec("COMMIT");
const dbBuild = ms(t);

// One write of each kind: append a log line to item n.
let seq = HISTORY + 1, made = 0;
const nextDoc = (n: number) => { logs[n]!.push({ at: iso(Date.now()), by: "wf-board", text: prose(200) }); return itemDoc(n, ++revs[n]!); };
function gitWrite(n: number): number {
  const path = `items/${ids[n]}.yaml`, text = nextDoc(n), start = process.hrtime.bigint();
  git(["diff", "--cached", "--name-only"]);
  writeFileSync(join(repo, path), text);
  git(["add", "--", path]);
  git(["-c", "commit.gpgsign=false", "commit", "-q", "--author", "wf-board <w@x.invalid>", "-m", `append_log ${ids[n]}`, "-m", "Session: probe"]);
  git(["show", "-s", "--format=%H%x00%aI", "HEAD"]);
  return ms(start);
}
function dbWrite(n: number): number {
  const path = `items/${ids[n]}.yaml`, text = nextDoc(n), start = process.hrtime.bigint();
  const s = ++seq, rev = ++dbRevs[n]!;
  db.exec("BEGIN");
  insEvent.run(s, iso(Date.now()), "wf-board", "probe", `w${made++}`, `append_log ${ids[n]}`);
  insVersion.run(s, path, rev, deflateRawSync(text)); putDoc.run(path, rev, s, text);
  db.exec("COMMIT");
  return ms(start);
}

// Interleaved blocks: git, SQLite and git again (the twin), in a rotating order.
const times = { git: [] as number[], db: [] as number[], twin: [] as number[] }, blocks: Array<{ git: number; db: number; twin: number }> = [];
for (let b = 0; b < BLOCKS; b++) {
  const block: Record<string, number[]> = { git: [], db: [], twin: [] };
  const order = [["git", "db", "twin"], ["db", "twin", "git"], ["twin", "git", "db"]][b % 3]!;
  for (const side of order) for (let w = 0; w < PER_BLOCK; w++) {
    const n = target();
    block[side]!.push(side === "db" ? dbWrite(n) : gitWrite(n));
  }
  for (const side of ["git", "db", "twin"] as const) times[side].push(...block[side]!);
  blocks.push({ git: median(block.git!), db: median(block.db!), twin: median(block.twin!) });
}
// A 95% interval of the ratio of block medians, by resampling the blocks.
function interval(ratio: (b: (typeof blocks)[number]) => number): [number, number, number] {
  const r = blocks.map(ratio), boots: number[] = [];
  for (let i = 0; i < 4000; i++) { const s = Array.from({ length: r.length }, () => r[Math.floor(rand() * r.length)]!); boots.push(median(s)); }
  return [median(r), quantile(boots, 0.025), quantile(boots, 0.975)];
}

// History reads. The versions of one item, as the repeated-write check asks for them.
const commitsOf = ids.map(() => 0);
for (const h of history) commitsOf[h.n]!++;
const cold = ids.findIndex((_, n) => commitsOf[n]! > 0 && commitsOf[n]! < 20), hot = commitsOf.indexOf(Math.max(...commitsOf));
const timeIt = (f: () => unknown, runs = 5) => { const a: number[] = []; for (let i = 0; i < runs; i++) { const s = process.hrtime.bigint(); f(); a.push(ms(s)); } return median(a); };
const gitVersions = (n: number) => git(["log", "-n", "20", "--format=%H%x00%s", "--", `items/${ids[n]}.yaml`]);
const versionsBefore = { cold: timeIt(() => gitVersions(cold)), hot: timeIt(() => gitVersions(hot)) };
// What changed over the last 2,400 commits, as `changes` and the owner's unread list read it.
const gitChanges = () => git(["log", "--name-only", "--format=%H", "-n", "2400"]);
const changesGit = timeIt(gitChanges, 3);
t = process.hrtime.bigint();
git(["commit-graph", "write", "--reachable", "--changed-paths", "--no-progress"]);
const bloomBuild = ms(t);
const versionsBloom = { cold: timeIt(() => gitVersions(cold)), hot: timeIt(() => gitVersions(hot)) };
const qVersions = db.prepare("SELECT seq, rev FROM versions WHERE path = ? ORDER BY rev DESC LIMIT 20");
const qChanges = db.prepare("SELECT DISTINCT path FROM versions WHERE seq > ?");
const qRequest = db.prepare("SELECT seq FROM events WHERE request = ?");
const versionsDb = { cold: timeIt(() => qVersions.all(`items/${ids[cold]}.yaml`)), hot: timeIt(() => qVersions.all(`items/${ids[hot]}.yaml`)) };
const changesDb = timeIt(() => qChanges.all(seq - 2400), 3), requestDb = timeIt(() => qRequest.get("r123"));

const du = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? du(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const summary = (a: number[]) => ({ p50: +median(a).toFixed(2), p90: +quantile(a, 0.9).toFixed(2), p99: +quantile(a, 0.99).toFixed(2), max: +Math.max(...a).toFixed(2) });
const result = {
  machine: `${process.platform} ${cpus().length} CPUs ${cpus()[0]?.model}`, node: process.version, git: git(["--version"]).trim(),
  sqlite: (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v,
  board: { items: ITEMS, cards: CARDS, notes: NOTES, history: HISTORY, coldCommits: commitsOf[cold], hotCommits: commitsOf[hot] },
  buildMs: { git: Math.round(gitBuild), sqlite: Math.round(dbBuild), bloom: Math.round(bloomBuild) },
  sizeMB: { git: +(du(join(repo, ".git")) / 1e6).toFixed(1), sqlite: +(statSync(dbFile).size / 1e6).toFixed(1) },
  writeMs: { git: summary(times.git), sqlite: summary(times.db), twin: summary(times.twin) },
  ratio: { sqliteOverGit: interval(b => b.db / b.git).map(x => +x.toFixed(4)), twinOverGit: interval(b => b.twin / b.git).map(x => +x.toFixed(3)) },
  versionsMs: { git: versionsBefore, gitBloom: versionsBloom, sqlite: versionsDb },
  changes2400Ms: { git: +changesGit.toFixed(1), sqlite: +changesDb.toFixed(2) }, requestLookupMs: +requestDb.toFixed(3),
};
console.log(`PROBE ${JSON.stringify(result)}`);
db.close();
rmSync(root, { recursive: true, force: true });
