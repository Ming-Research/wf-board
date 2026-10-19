// Temporary measurement of the heap that parsed board documents keep (board item board-heap), from the study's script
// (scripts/study-heap.ts on the branch board-heap-study). It lives on this branch only and is deleted before the merge; the
// numbers it prints go on the board item and into docs/design.md. This tree is the candidate; a base src directory (--base-src)
// is the commit the branch started from, and a twin of it is the control of the pairs.
//
// It writes synthetic boards in two shapes, then runs each stage in a child process of its own (so heap figures do not mix),
// with the daemon's 4 GB heap and --expose-gc. A stage holds what it built, collects twice and prints the heap it kept.
//   quoted  the shape of the first study (scripts/bench-changes.ts): every long text is one line ending in a space, so the
//           YAML library writes it, and reads it back, as a double-quoted scalar; 1,674 items, 633 cards, 927 notes, 32.7 MB
//   block   the shape of the live board: long texts are multi-line `|-` block scalars, about 66% non-ASCII bytes, 81 bytes a
//           line; 1,942 items, 839 cards, 1,210 notes, about 22 MB (counts and sizes read off the live data directory)
// Stages:
//   micro      one scalar of each YAML style parsed 300 times: heap per character, before and after the strings are flattened
//   text       the files read as strings (what the sources cost)
//   parse      the files parsed (the daemon's options), sources dropped; then every string flattened by JSON.stringify
//   freeze     parse and deep freeze (what the historical-document cache holds)
//   clone      parse then structuredClone, the original dropped
//   json       parse then JSON.parse(JSON.stringify(doc))
//   strings    parse, then every string rebuilt flat in place (structure and keys unchanged)
//   structure  parse, then every string replaced by "" (the skeleton of objects and arrays alone)
//   validate   parse, zod-validate and freeze the way Store.open does; only the validated documents are kept
//   validate-clone  the same with a structuredClone between parse and validation
//   buffers    the files kept as Buffer copies (what a cache of source bytes would hold), heap and off-heap
//   jsonload   all validated documents as one JSON text: write time, read time, heap kept
//   jsyaml     the js-yaml parser on the same files (when JS_YAML_DIR names an install of it)
//   open       the real Store.open: time per startup step and heap kept
//   rebuild    the real comparisonSnapshot: heap kept, then after dropping the document cache, then the snapshot
//   snapshot   a heap snapshot of 300 parsed files, summed by V8's node type (cons and sliced strings are types of their own)
//   daemon     the real daemon (src/main.ts) on the board: resident memory and heap by space after the start, after five page
//              loads (GET /api/snapshot) and after 15 s idle
// open, rebuild and daemon run twice: on this tree (label cand) and on the base (label base).
// With --pairs N the open stage then runs N rounds of base, its twin and this tree, in an order drawn afresh each round, each in a
// process of its own, and the time of the startup step "read documents" is compared over the rounds.
//
// Usage: node tmp-heap/study.ts --base-src <dir> [--scale 0.03] [--stages a,b] [--variants quoted,block] [--pairs 15]
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import v8 from "node:v8";
import { parse, stringify } from "yaml";
import { Item, Decision, Note, Board } from "../src/model.ts";
import { compare, randomOrder, reference, show, tQuantile } from "../test/nkey/stats.ts";
import { prng } from "../test/e2e/board-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: {
  scale: { type: "string", default: "1" }, stages: { type: "string" }, variants: { type: "string" },
  stage: { type: "string" }, variant: { type: "string" }, dir: { type: "string" }, src: { type: "string" }, label: { type: "string" },
  "base-src": { type: "string" }, pairs: { type: "string", default: "0" },
} });
const SCALE = Number(args.scale);
/** The source tree the open, rebuild and daemon stages load: this one, or the base the driver names. */
const srcDir = args.src ? resolve(args.src) : join(here, "../src");
const STAGES = ["micro", "text", "parse", "freeze", "clone", "json", "strings", "structure", "validate", "validate-clone", "buffers", "jsonload", "jsyaml", "open", "rebuild", "snapshot", "daemon"];
const VARIANTS: Record<string, { items: number; decisions: number; notes: number }> = {
  quoted: { items: 1674, decisions: 633, notes: 927 },
  block: { items: 1942, decisions: 839, notes: 1210 },
};
const OPTS = { version: "1.2", schema: "core" } as const;
const yaml = (value: unknown) => stringify(value, { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" });
const MINUTE = 60_000, iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const heap = () => v8.getHeapStatistics().used_heap_size;
const mb = (bytes: number) => +(bytes / 1048576).toFixed(1);
const gc = () => { (globalThis as { gc?: () => void }).gc?.(); (globalThis as { gc?: () => void }).gc?.(); };

// ---- the synthetic boards -------------------------------------------------------------------------------------------

// The first study's text: mixed Chinese and ASCII, one line, ending in a space.
const sentence = "看板服务读历史时只读需要的文件 and keeps the cost bounded by the range. ";
const pad = (bytes: number) => sentence.repeat(Math.ceil(bytes / Buffer.byteLength(sentence)));
// The live board's text: lines of about 81 bytes, 18 Chinese characters and 27 ASCII bytes, a blank line after every sixth.
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

function quotedBoard(n: { items: number; decisions: number; notes: number }): Map<string, string> {
  const files = new Map<string, string>(), at = iso(Date.UTC(2026, 9, 1));
  const projects = ["Whitefoot", "Firn", "Halo", "Snowghost", "kit", "Architect"], ids: string[] = [];
  for (let i = 0; i < n.items; i++) ids.push(`p${i % projects.length}-${Math.floor(i / projects.length)}`);
  const decisions: string[] = [];
  for (let k = 0; k < n.decisions; k++) {
    decisions.push(`c${k}`);
    files.set(`decisions/c${k}.yaml`, yaml({ num: n.items + k + 1, item: ids[(k * 7) % ids.length], question: `Question ${k}?`, legacy: { background: pad(5200) }, options: [{ key: "A", text: "", detail: "Do it", recommended: true }, { key: "B", text: "", detail: "Do not" }], status: "ruled", choice: "A", ruling: "A", ruledAt: at, at, updated: at, rev: 1 }));
  }
  for (let k = 0; k < n.notes; k++) files.set(`notes/n${k}.yaml`, yaml({ target: k % 2 === 0 ? `q:${decisions[k % decisions.length]}` : `it:${ids[(k * 5) % ids.length]}`, kind: "comment", text: pad(4000), at, state: "done", sentAt: at, reply: "Handled", repliedAt: at, repliedBy: "Firn", rev: 1 }));
  ids.forEach((id, i) => files.set(`items/${id}.yaml`, yaml({ num: i + 1, title: `Item ${id}`, group: projects[i % projects.length], head: pad(7600), log: [], plan: [{ id: "w", text: "work", state: "doing", since: at }, { id: "accept", text: "passes", state: "todo", accept: true }], created: at, updated: at, rev: 1 })));
  return withBoardFiles(files, projects, n.items + n.decisions + 1);
}

function blockBoard(n: { items: number; decisions: number; notes: number }): Map<string, string> {
  const files = new Map<string, string>(), start = Date.UTC(2026, 9, 1), at = iso(start);
  const projects = ["Whitefoot", "Firn", "Halo", "Snowghost", "kit", "Architect"], ids: string[] = [];
  for (let i = 0; i < n.items; i++) ids.push(`p${i % projects.length}-${Math.floor(i / projects.length)}`);
  const decisions: string[] = [];
  for (let k = 0; k < n.decisions; k++) {
    decisions.push(`c${k}`);
    files.set(`decisions/c${k}.yaml`, yaml({ num: n.items + k + 1, item: ids[(k * 7) % ids.length], question: `卡 ${k} 要问什么？`, kind: "design",
      options: [{ key: "A", text: "", detail: block(1100, k), recommended: true }, { key: "B", text: "", detail: block(900, k + 1) }, { key: "C", text: "", detail: block(700, k + 2) }],
      confidence: { score: 4, reason: block(300, k + 3) }, status: "ruled", choice: "A", ruling: block(200, k + 4), ruledAt: at, at, updated: at, rev: 1 }));
  }
  for (let k = 0; k < n.notes; k++) files.set(`notes/n${k}.yaml`, yaml({ target: k % 2 === 0 ? `q:${decisions[k % decisions.length]}` : `it:${ids[(k * 5) % ids.length]}`, kind: "comment", text: block(300, k), at, state: "done", sentAt: at, reply: block(200, k + 1), repliedAt: at, repliedBy: "Firn", rev: 1 }));
  ids.forEach((id, i) => {
    const rows = Array.from({ length: 8 }, (_, k) => k % 3 === 0
      ? { id: `s${k}`, text: `步骤 ${k}: 要做的事，写成一句话 ${id}`, state: "done", doneAt: at }
      : { id: `s${k}`, text: `步骤 ${k}，要做的事，写成一句话 ${id}`, state: "done", doneAt: at });
    files.set(`items/${id}.yaml`, yaml({ num: i + 1, title: `条目 ${id} 的标题，写成一句话`, group: projects[i % projects.length], difficulty: 2, head: block(4200, i),
      log: Array.from({ length: 12 }, (_, k) => ({ at: iso(start + k * MINUTE), by: projects[i % projects.length], text: block(240, i * 13 + k) })),
      plan: [...rows, { id: "accept", text: "验收：每个问题都有回答", state: "todo", accept: true }],
      links: [{ label: "wf-board#1", url: "https://github.com/Ming-Research/wf-board/pull/1" }], created: at, updated: at, rev: 13 }));
  });
  return withBoardFiles(files, projects, n.items + n.decisions + 1);
}

function withBoardFiles(files: Map<string, string>, projects: string[], next: number): Map<string, string> {
  files.set("board.yaml", yaml({ title: "Synthetic board", projects: projects.map(name => ({ name })) }));
  files.set("numbers.yaml", yaml({ next }));
  return files;
}

function writeBoard(dir: string, files: Map<string, string>): void {
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "Seed synthetic board"], { cwd: dir });
}

// ---- helpers for the stages -----------------------------------------------------------------------------------------

/** The data files of a board directory, `board.yaml` first. */
function boardPaths(dir: string): string[] {
  const out = ["board.yaml"];
  for (const sub of ["items", "decisions", "notes"]) for (const file of readdirSync(join(dir, sub)).sort()) out.push(`${sub}/${file}`);
  return out;
}
const schemaOf = (path: string) => path === "board.yaml" ? Board : path.startsWith("items/") ? Item : path.startsWith("decisions/") ? Decision : Note;

function omitUndefined(value: unknown): void {
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    if (child === undefined) delete (value as Record<string, unknown>)[key];
    else omitUndefined(child);
  }
}
/** Store.validated: zod's parse, then undefined properties dropped. */
function validated(path: string, value: unknown): unknown {
  const result = (schemaOf(path) as { safeParse(v: unknown): { success: boolean; data?: unknown; error?: unknown } }).safeParse(value);
  if (!result.success) throw new Error(`${path} did not validate: ${JSON.stringify((result.error as { issues?: unknown }).issues).slice(0, 300)}`);
  omitUndefined(result.data);
  return result.data;
}
/** Store.frozen. */
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
/** Every string of a parsed tree replaced by `f(string)`, in place. */
function mapStrings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === "string") return f(value);
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = mapStrings(value[i], f); return value; }
  if (value && typeof value === "object") { const o = value as Record<string, unknown>; for (const k of Object.keys(o)) o[k] = mapStrings(o[k], f); return o; }
  return value;
}
/** A fresh, flat copy of a string: rebuilt from its UTF-8 bytes. */
const flat = (s: string) => s.length < 13 ? s : Buffer.from(s, "utf8").toString("utf8");
/** Counts in a set of parsed documents. */
function shape(docs: unknown[]): Record<string, number> {
  const c = { objects: 0, arrays: 0, strings: 0, stringChars: 0, twoByteStrings: 0, longStrings: 0, numbers: 0 };
  const visit = (v: unknown): void => {
    if (typeof v === "string") { c.strings++; c.stringChars += v.length; if (v.length >= 13) c.longStrings++; if (/[^\u0000-ÿ]/.test(v)) c.twoByteStrings++; }
    else if (Array.isArray(v)) { c.arrays++; v.forEach(visit); }
    else if (v && typeof v === "object") { c.objects++; Object.values(v).forEach(visit); }
    else if (typeof v === "number") c.numbers++;
  };
  docs.forEach(visit);
  return c;
}

const keep: unknown[] = [];
/** Runs `work`, holds what it returns, collects twice and says how much heap the result keeps. */
async function retained<T>(work: () => T | Promise<T>): Promise<{ ms: number; retainedMB: number; base: number; value: T }> {
  gc();
  const base = heap(), t0 = performance.now();
  const value = await work();
  const ms = Math.round(performance.now() - t0);
  keep.push(value);
  gc();
  return { ms, retainedMB: mb(heap() - base), base, value };
}
const sinceBase = (base: number) => { gc(); return mb(heap() - base); };

interface Ctx { dir: string; paths: string[]; abs: string[]; bytes: number }
const read = (p: string) => readFileSync(p, "utf8");
const parseAll = (c: Ctx) => c.abs.map(p => parse(read(p), OPTS) as unknown);

const stages: Record<string, (c: Ctx) => Promise<Record<string, unknown>>> = {
  async micro() {
    // One scalar per YAML style, parsed 300 times and held: heap per copy before and after its strings are flattened.
    const one = block(6000, 3).replace(/\n+/g, " ").trim() + " ";
    const multi = block(6000, 3);
    const styles: Record<string, string> = {
      "double-quoted, one line": yaml({ k: one }),
      "plain, one line": yaml({ k: one.trim().replace(/[#:]/g, "") }),
      "single-quoted, one line": yaml({ k: '"' + one.trim() }),
      "block literal, 6 KB in 75 lines": yaml({ k: multi }),
    };
    const out: Record<string, unknown> = {};
    for (const [name, text] of Object.entries(styles)) {
      const value = parse(text, OPTS) as { k: string };
      const chars = value.k.length;
      // Each copy has a source of its own (a comment line makes it differ), as every file of the board does.
      const r = await retained(() => Array.from({ length: 300 }, (_, i) => parse(`${text}# ${i}\n`, OPTS)));
      const before = r.retainedMB;
      r.value.forEach(v => JSON.stringify(v));
      const after = sinceBase(r.base);
      out[name] = { style: text.slice(0, 7).replace(/\n/g, "\\n"), chars, fileBytes: Buffer.byteLength(text), heapPerCopyKB: +(before * 1024 / 300).toFixed(1), heapPerCopyFlattenedKB: +(after * 1024 / 300).toFixed(1), bytesPerChar: +(before * 1048576 / 300 / chars).toFixed(1), bytesPerCharFlattened: +(after * 1048576 / 300 / chars).toFixed(1) };
      keep.length = 0;
    }
    return out;
  },
  async text(c) {
    const r = await retained(() => c.abs.map(read));
    return { retainedMB: r.retainedMB, ms: r.ms, chars: r.value.reduce((n, t) => n + t.length, 0) };
  },
  async parse(c) {
    const r = await retained(() => parseAll(c));
    const docs = r.value;
    const counts = shape(docs);
    // JSON.stringify flattens every string it writes, in place; whatever was only the shape of a concatenation goes.
    const t0 = performance.now();
    docs.forEach(d => JSON.stringify(d));
    const stringifyMs = Math.round(performance.now() - t0);
    return { parseMs: r.ms, retainedMB: r.retainedMB, afterFlattenMB: sinceBase(r.base), stringifyMs, ...counts };
  },
  async freeze(c) {
    const r = await retained(() => parseAll(c).map(frozen));
    return { ms: r.ms, retainedMB: r.retainedMB };
  },
  async clone(c) {
    let cloneMs = 0;
    const r = await retained(() => c.abs.map(p => { const d = parse(read(p), OPTS); const t = performance.now(); const x = structuredClone(d); cloneMs += performance.now() - t; return x; }));
    return { ms: r.ms, cloneMs: Math.round(cloneMs), retainedMB: r.retainedMB };
  },
  async json(c) {
    let jsonMs = 0;
    const r = await retained(() => c.abs.map(p => { const d = parse(read(p), OPTS); const t = performance.now(); const x = JSON.parse(JSON.stringify(d)); jsonMs += performance.now() - t; return x; }));
    return { ms: r.ms, roundTripMs: Math.round(jsonMs), retainedMB: r.retainedMB };
  },
  async strings(c) {
    let flatMs = 0;
    const r = await retained(() => parseAll(c).map(d => { const t = performance.now(); mapStrings(d, flat); flatMs += performance.now() - t; return d; }));
    return { ms: r.ms, flattenMs: Math.round(flatMs), retainedMB: r.retainedMB };
  },
  async structure(c) {
    const r = await retained(() => parseAll(c).map(d => mapStrings(d, () => "")));
    return { ms: r.ms, retainedMB: r.retainedMB, ...shape(r.value) };
  },
  async validate(c) { return validateStage(c, false); },
  async "validate-clone"(c) { return validateStage(c, true); },
  async buffers(c) {
    const external0 = process.memoryUsage().arrayBuffers;
    const r = await retained(() => c.abs.map(p => Buffer.from(readFileSync(p))));
    gc();
    const t0 = performance.now();
    r.value.forEach(b => parse(b.toString("utf8"), OPTS));
    return { retainedHeapMB: r.retainedMB, offHeapMB: mb(process.memoryUsage().arrayBuffers - external0), parseAllMs: Math.round(performance.now() - t0) };
  },
  async jsonload(c) {
    let text: Buffer;
    let writeMs: number;
    {
      const docs: Record<string, unknown> = {};
      for (const [i, p] of c.abs.entries()) docs[c.paths[i]!] = frozen(validated(c.paths[i]!, parse(read(p), OPTS)));
      const t0 = performance.now();
      text = Buffer.from(JSON.stringify(docs));
      writeMs = Math.round(performance.now() - t0);
    }
    const r = await retained(() => JSON.parse(text.toString("utf8")) as Record<string, unknown>);
    const t1 = performance.now();
    Object.entries(r.value).forEach(([p, d]) => validated(p, d));
    const validateAgainMs = Math.round(performance.now() - t1);
    return { jsonMB: mb(text.length), writeMs, readMs: r.ms, retainedMB: r.retainedMB, validateAgainMs };
  },
  async jsyaml(c) {
    const dirName = process.env.JS_YAML_DIR;
    if (!dirName) return { skipped: "JS_YAML_DIR not set" };
    const jsYaml = await import(pathToFileURL(join(dirName, "node_modules/js-yaml/dist/js-yaml.mjs")).href) as { load(text: string, opts: unknown): unknown; CORE_SCHEMA: unknown };
    const r = await retained(() => c.abs.map(p => jsYaml.load(read(p), { schema: jsYaml.CORE_SCHEMA })));
    let different = 0;
    const reference = parseAll(c);
    for (let i = 0; i < reference.length; i++) if (JSON.stringify(reference[i]) !== JSON.stringify(r.value[i])) different++;
    const afterFlatten = sinceBase(r.base);
    return { ms: r.ms, retainedMB: r.retainedMB, afterFlattenMB: afterFlatten, documentsDifferentFromYamlParse: different };
  },
  async open(c) {
    const { Store } = await import(pathToFileURL(join(srcDir, "store.ts")).href) as { Store: { open(dir: string, opts: unknown): Promise<unknown> } };
    const laps: string[] = [];
    const r = await retained(() => Store.open(c.dir, { startup: (step: string, ms: number, detail?: string) => laps.push(`${step}: ${Math.round(ms)} ms${detail ? ` (${detail})` : ""}`) }));
    return { ms: r.ms, retainedMB: r.retainedMB, laps };
  },
  async rebuild(c) {
    const { Store } = await import(pathToFileURL(join(srcDir, "store.ts")).href) as { Store: { open(dir: string, opts: unknown): Promise<any> } };
    const store = await Store.open(c.dir, {});
    gc();
    const base = heap(), t0 = performance.now();
    let board: unknown = await store.comparisonSnapshot(store.snapshot().head);
    const ms = Math.round(performance.now() - t0);
    keep.push(board);
    board = undefined;
    const afterRebuild = sinceBase(base);
    store.historicalDocuments.entries.clear();
    const afterDroppingDocuments = sinceBase(base);
    store.compared.entries.clear();
    keep.length = 0;
    return { ms, afterRebuildMB: afterRebuild, afterDroppingDocumentCacheMB: afterDroppingDocuments, afterDroppingSnapshotToo: sinceBase(base) };
  },
  async daemon(c) {
    const port = 17400 + Math.floor(Math.random() * 500), stats = join(tmpdir(), `study-heap-stats-${process.pid}.json`);
    const preload = `import v8 from "node:v8"; import { writeFileSync } from "node:fs"; process.on("SIGUSR2", () => { globalThis.gc?.(); globalThis.gc?.(); writeFileSync(process.env.STUDY_STATS, JSON.stringify({ heap: v8.getHeapStatistics(), spaces: v8.getHeapSpaceStatistics(), mem: process.memoryUsage() })); });`;
    const started = performance.now();
    const child = spawn(process.execPath, ["--max-old-space-size=4096", "--expose-gc", "--import", `data:text/javascript,${encodeURIComponent(preload)}`, join(srcDir, "main.ts")], {
      env: { ...process.env, WF_BOARD_DATA: c.dir, WF_BOARD_PORT: String(port), WF_BOARD_FIRST_PUSH_MS: "3600000", WF_BOARD_CREDENTIALS: join(tmpdir(), "study-heap-no-credentials.json"), STUDY_STATS: stats },
      stdio: ["ignore", "pipe", "pipe"] });
    let log = "", memoryLine: string | undefined;
    const take = (d: Buffer) => { log += d; log = log.slice(-4000); memoryLine ??= /startup memory: [^\n]*/.exec(String(d))?.[0]; };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const sleep = (ms: number) => new Promise(ok => setTimeout(ok, ms));
    let healthy = false;
    for (let i = 0; i < 600 && !healthy && child.exitCode === null; i++) {
      healthy = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false);
      if (!healthy) await sleep(200);
    }
    if (!healthy) { child.kill("SIGKILL"); return { failed: "the daemon did not answer /health", exitCode: child.exitCode, log: log.slice(-1500) }; }
    const startMs = Math.round(performance.now() - started);
    const status = () => readFileSync(`/proc/${child.pid}/status`, "utf8");
    const kb = (text: string, name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? 0);
    const sample = async () => {
      const before = status();
      rmSync(stats, { force: true });
      child.kill("SIGUSR2");
      for (let i = 0; i < 300 && !existsSync(stats); i++) await sleep(100);
      await sleep(300);
      const j = JSON.parse(readFileSync(stats, "utf8")) as { heap: Record<string, number>; spaces: Array<{ space_name: string; space_used_size: number }>; mem: Record<string, number> };
      const after = status();
      return { rssBeforeGcMB: mb(kb(before, "VmRSS") * 1024), rssAfterGcMB: mb(kb(after, "VmRSS") * 1024), rssPeakMB: mb(kb(after, "VmHWM") * 1024), heapUsedMB: mb(j.heap.used_heap_size!), heapTotalMB: mb(j.heap.total_heap_size!), heapPhysicalMB: mb(j.heap.total_physical_size!), externalMB: mb(j.heap.external_memory!), arrayBuffersMB: mb(j.mem.arrayBuffers!), spacesUsedMB: Object.fromEntries(j.spaces.map(x => [x.space_name, mb(x.space_used_size)])) };
    };
    await sleep(3000);
    const afterStart = await sample();
    for (let i = 0; i < 5; i++) await fetch(`http://127.0.0.1:${port}/api/snapshot`).then(r => r.arrayBuffer(), () => undefined);
    const afterPageLoads = await sample();
    await sleep(15_000);
    const idle = await sample();
    child.kill("SIGTERM");
    return { startMs, memoryLine, afterStart, afterPageLoads, idle };
  },
  async snapshot(c) {
    const step = Math.max(1, Math.floor(c.abs.length / 300));
    const sample = c.abs.filter((_, i) => i % step === 0);
    const docs = sample.map(p => parse(read(p), OPTS));
    keep.push(docs);
    gc();
    const parsedHeapMB = mb(heap());
    const file = join(tmpdir(), `study-heap-${process.pid}.heapsnapshot`);
    v8.writeHeapSnapshot(file);
    const snap = JSON.parse(readFileSync(file, "utf8")) as { snapshot: { meta: { node_fields: string[]; node_types: [string[]] } }; nodes: number[] };
    const fields = snap.snapshot.meta.node_fields, width = fields.length, types = snap.snapshot.meta.node_types[0];
    const typeAt = fields.indexOf("type"), sizeAt = fields.indexOf("self_size");
    const sums = new Map<string, { count: number; bytes: number }>();
    for (let i = 0; i < snap.nodes.length; i += width) {
      const type = types[snap.nodes[i + typeAt]!]!, bytes = snap.nodes[i + sizeAt]!;
      const s = sums.get(type) ?? { count: 0, bytes: 0 };
      s.count++; s.bytes += bytes; sums.set(type, s);
    }
    const sampleBytes = sample.reduce((n, p) => n + statSync(p).size, 0);
    const byType = Object.fromEntries([...sums].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 10).map(([type, s]) => [type, { count: s.count, MB: mb(s.bytes) }]));
    return { files: sample.length, fileMB: mb(sampleBytes), parsedHeapMB, byType, ...shape(docs) };
  },
};

async function validateStage(c: Ctx, withClone: boolean): Promise<Record<string, unknown>> {
  let parseMs = 0, cloneMs = 0, validateMs = 0, freezeMs = 0;
  const r = await retained(() => {
    const out: Record<string, unknown> = {};
    for (const [i, p] of c.abs.entries()) {
      let t = performance.now();
      let raw = parse(read(p), OPTS);
      parseMs += performance.now() - t;
      if (withClone) { t = performance.now(); raw = structuredClone(raw); cloneMs += performance.now() - t; }
      t = performance.now();
      const v = validated(c.paths[i]!, raw);
      validateMs += performance.now() - t;
      t = performance.now();
      out[c.paths[i]!] = frozen(v);
      freezeMs += performance.now() - t;
    }
    return out;
  });
  return { ms: r.ms, parseMs: Math.round(parseMs), ...(withClone ? { cloneMs: Math.round(cloneMs) } : {}), validateMs: Math.round(validateMs), freezeMs: Math.round(freezeMs), retainedMB: r.retainedMB };
}

// ---- driver ---------------------------------------------------------------------------------------------------------

if (args.stage) {
  const dir = resolve(args.dir!);
  const paths = boardPaths(dir), abs = paths.map(p => join(dir, p));
  const bytes = abs.reduce((n, p) => n + statSync(p).size, 0);
  const result = await stages[args.stage]!({ dir, paths, abs, bytes });
  console.log(`STUDY ${JSON.stringify({ variant: args.variant, src: args.label ?? "main", stage: args.stage, files: paths.length, fileMB: mb(bytes), ...result })}`);
  process.exit(0);
}

console.log(`machine: ${cpus().length} CPUs (${cpus()[0]?.model}), ${mb(totalmem())} MB memory, node ${process.version}, scale ${SCALE}`);
const baseSrc = args["base-src"] ? resolve(args["base-src"]) : undefined;
if (!baseSrc) throw new Error("--base-src names the base commit's src directory");
/** Runs one stage in a child process of its own (4 GB heap, --expose-gc) and returns its STUDY line, or a failure record. */
function runStage(stage: string, label: string, src: string, name: string, dir: string): Promise<Record<string, any>> {
  return new Promise(ok => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ["--max-old-space-size=4096", "--expose-gc", fileURLToPath(import.meta.url), "--stage", stage, "--variant", name, "--dir", dir, "--src", src, "--label", label], { stdio: ["ignore", "pipe", "inherit"] });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
    let output = "";
    child.stdout.on("data", (d: Buffer) => { output += d; });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      const line = output.split("\n").find(l => l.startsWith("STUDY "));
      ok(line ? JSON.parse(line.slice("STUDY ".length)) : { variant: name, src: label, stage, failed: true, exitCode: code, signal, ms: Date.now() - t0 });
    });
  });
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
const interval = (xs: number[], unit: string) => { const m = mean(xs), h = tQuantile(xs.length - 1) * sd(xs) / Math.sqrt(xs.length); return `${m.toFixed(1)} ${unit} [${(m - h).toFixed(1)}, ${(m + h).toFixed(1)}]`; };
/** The milliseconds of the startup step `step` in the laps the open stage printed. */
const lapMs = (laps: string[], step: string): number => Number(new RegExp(`^${step}: (\\d+) ms`).exec(laps.find(l => l.startsWith(`${step}:`)) ?? "")?.[1] ?? NaN);

const root = await mkdtemp(join(tmpdir(), "wf-board-study-heap-"));
try {
  const wantedVariants = (args.variants ?? Object.keys(VARIANTS).join(",")).split(",");
  const wantedStages = (args.stages ?? STAGES.join(",")).split(",");
  const ROUNDS = Number(args.pairs);
  for (const name of wantedVariants) {
    const n = VARIANTS[name]!, scaled = { items: Math.max(6, Math.round(n.items * SCALE)), decisions: Math.max(3, Math.round(n.decisions * SCALE)), notes: Math.max(3, Math.round(n.notes * SCALE)) };
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    writeBoard(dir, name === "quoted" ? quotedBoard(scaled) : blockBoard(scaled));
    console.log(`board ${name}: ${scaled.items} items, ${scaled.decisions} cards, ${scaled.notes} notes, built in ${Date.now() - t0} ms`);
    // The stages on this tree, then three of them on the base.
    const jobs: Array<{ stage: string; label: string; src: string }> = wantedStages.map(stage => ({ stage, label: "cand", src: srcDir }));
    for (const stage of ["open", "rebuild", "daemon"]) if (wantedStages.includes(stage)) jobs.push({ stage, label: "base", src: baseSrc });
    for (const { stage, label, src } of jobs) {
      // The micro stage does not depend on a board shape.
      if (stage === "micro" && name !== wantedVariants[0]) continue;
      console.log(`STUDY ${JSON.stringify(await runStage(stage, label, src, name, dir))}`);
    }
    if (ROUNDS > 0) {
      const sides = [{ label: "base", src: baseSrc }, { label: "twin", src: baseSrc }, { label: "cand", src: srcDir }];
      const read: Record<string, number[]> = { base: [], twin: [], cand: [] }, kept: Record<string, number[]> = { base: [], twin: [], cand: [] };
      const rnd = prng(Math.floor(Math.random() * 2 ** 31));
      for (let round = 1; round <= ROUNDS; round++) {
        for (const k of randomOrder(sides.length, rnd.next)) {
          const side = sides[k]!, r = await runStage("open", side.label, side.src, name, dir);
          if (r.failed) throw new Error(`open (${side.label}, round ${round}) failed: ${JSON.stringify(r)}`);
          read[side.label]!.push(lapMs(r.laps, "read documents")); kept[side.label]!.push(r.retainedMB);
          console.log(`pairs ${name} round ${round} ${side.label}: read documents ${lapMs(r.laps, "read documents")} ms, open ${r.ms} ms, kept ${r.retainedMB} MB`);
        }
      }
      const diff = (a: number[], b: number[]) => a.map((x, i) => x - b[i]!);
      const ref = reference(read.base!, read.twin!);
      console.log(`PAIRS ${name}: read documents, ${ROUNDS} rounds (milliseconds per open; the interval is the 95% interval of the mean)`);
      for (const label of ["base", "twin", "cand"]) console.log(`  ${label}: ${interval(read[label]!, "ms")}; heap kept ${interval(kept[label]!, "MB")}`);
      console.log(`  twin/base ${show(compare(read.twin!, read.base!))}`);
      console.log(`  cand/base ${show(compare(read.cand!, read.base!))}`);
      console.log(`  cand/ref ${show(compare(read.cand!, ref))}`);
      console.log(`  cand - ref ${interval(diff(read.cand!, ref), "ms")}; twin - base ${interval(diff(read.twin!, read.base!), "ms")}; cand - base ${interval(diff(read.cand!, read.base!), "ms")}`);
      console.log(`  heap cand - base ${interval(diff(kept.cand!, kept.base!), "MB")}`);
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
