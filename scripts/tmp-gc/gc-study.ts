// TEMPORARY harness of item data-repo-gc-timing-study; deleted before the study ends, never merged.
// It builds a data repository of the live one's size (counts read from the live repository, no content) and times git's
// maintenance on it. Commands: cost | knobs | packs | shard   (STUDY_SMOKE=1: a tiny scale, to check the script runs).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";

const SMOKE = process.env.STUDY_SMOKE === "1";
const ROOT = process.env.STUDY_DIR ?? mkdtempSync(join(tmpdir(), "gcstudy-"));
// Live (read 2026-10-17): 20260 commits, 1749 items, 729 cards, 1032 notes. Pack A (the 10-14 gc) holds the first 15670
// commits; the gc of 10-16 22:52Z built pack B from the next 3741 commits. Pack X below stands for the part of B that was
// already packed when that gc ran (3741 commits less the 2160 whose 9087 objects were still loose).
// `growth <k>` multiplies the number of documents by k, to see what a larger board costs per commit.
const GROW = process.argv[2] === "growth" ? Number(process.argv[3] ?? 1) : 1;
const SCALE = SMOKE
  ? { items: 60 * GROW, decisions: 25 * GROW, notes: 35 * GROW, history: 300, packX: 40, preLoose: 80 }
  : { items: 1749 * GROW, decisions: 729 * GROW, notes: 1032 * GROW, history: 15670, packX: 1580, preLoose: 2160 };
const ROUNDS = (n: number) => SMOKE ? 2 : n;
const FG = ["-c", "gc.autoDetach=false", "-c", "maintenance.autoDetach=false"];
const NO_AUTO = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];
const FORCE = ["-c", "gc.auto=1"];
const GITENV: Record<string, string> = {
  ...process.env as Record<string, string>, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Study", GIT_AUTHOR_EMAIL: "study@example.invalid", GIT_COMMITTER_NAME: "wf-board", GIT_COMMITTER_EMAIL: "wf-board@wf-board.invalid",
};

// ---------------------------------------------------------------- helpers
function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync("git", args, { cwd: dir, env: { ...GITENV, ...env }, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} -> ${r.status}\n${r.stderr}`);
  return r.stdout;
}
function timed(dir: string, args: string[], env: Record<string, string> = {}): { ms: number; status: number | null; err: string } {
  const t0 = performance.now();
  const r = spawnSync("git", args, { cwd: dir, env: { ...GITENV, ...env }, encoding: "utf8", maxBuffer: 1 << 30 });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} -> ${r.status}\n${r.stderr}`);
  return { ms, status: r.status, err: r.stderr };
}
function sh(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} -> ${r.status}\n${r.stderr}`);
}
let copies = 0;
function copyRepo(src: string, name: string): string {
  const dst = join(ROOT, `${name}-${copies++}`);
  sh("cp", ["-a", src, dst]);
  return dst;
}
function counts(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of git(dir, ["count-objects", "-v"]).trim().split("\n")) { const [k, v] = line.split(": "); out[k!] = Number(v); }
  return out;
}
const shape = (dir: string) => { const c = counts(dir); return `loose ${c.count} (${c.size} KB), in-pack ${c["in-pack"]}, packs ${c.packs} (${c["size-pack"]} KB)`; };
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const T95 = [0, 12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05, 2.04];
/** Geometric mean of a/b over pairs, with the 95% interval of the mean log ratio. */
function ratioCi(a: number[], b: number[]): { ratio: number; lo: number; hi: number; half: number } {
  const l = a.map((x, i) => Math.log(x / b[i]!)), m = mean(l), h = (T95[Math.min(30, l.length - 1)] ?? 1.96) * sd(l) / Math.sqrt(l.length);
  return { ratio: Math.exp(m), lo: Math.exp(m - h), hi: Math.exp(m + h), half: Math.exp(h) - 1 };
}
const f = (x: number, d = 0) => x.toFixed(d);
function emit(title: string, rows: Record<string, unknown>[]): void {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]!);
  const md = [`\n### ${title}\n`, `| ${keys.join(" | ")} |`, `|${keys.map(() => "---").join("|")}|`, ...rows.map(r => `| ${keys.map(k => String(r[k])).join(" | ")} |`)].join("\n");
  console.log(md);
  for (const r of rows) console.log("RESULT " + JSON.stringify({ title, ...r }));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}
function note(text: string): void {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n\n");
}

// ---------------------------------------------------------------- the synthetic board
class Rng {
  s: number;
  constructor(seed: number) { this.s = seed; }
  next(): number { let t = (this.s += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  int(n: number): number { return Math.floor(this.next() * n); }
  gauss(): number { return Math.sqrt(-2 * Math.log(1 - this.next())) * Math.cos(2 * Math.PI * this.next()); }
  lognormal(median: number, sigma: number): number { return Math.exp(Math.log(median) + sigma * this.gauss()); }
}
const CONSONANTS = "bcdfghjklmnprstvwz", VOWELS = "aeiou";
function asciiWord(r: Rng): string { let s = ""; for (let i = 0, n = 2 + r.int(4); i < n; i++) s += CONSONANTS[r.int(18)]! + VOWELS[r.int(5)]! + (r.next() < 0.3 ? CONSONANTS[r.int(18)]! : ""); return s; }
const vocab = new Rng(7);
const ASCII_WORDS = Array.from({ length: 2500 }, () => asciiWord(vocab));
const CJK = Array.from({ length: 3000 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7919) % 20000)));
/** Text like the board's: mostly Chinese, with English words (the live files are mostly Chinese). Skewed so it compresses like prose. */
function text(r: Rng, bytes: number): string {
  let s = "", n = 0;
  while (n < bytes) {
    let t: string;
    if (r.next() < 0.3) t = ASCII_WORDS[Math.floor(2500 * r.next() ** 2)]!;
    else { t = ""; for (let i = 0, k = 2 + r.int(5); i < k; i++) t += CJK[Math.floor(3000 * r.next() ** 2.5)]!; }
    t += r.next() < 0.08 ? "。\n" : " ";
    s += t; n += Buffer.byteLength(t);
  }
  return s;
}
function quantile(points: [number, number][], u: number): number {
  for (let i = 1; i < points.length; i++) if (u <= points[i]![0]) { const [u0, v0] = points[i - 1]!, [u1, v1] = points[i]!; return v0 + (v1 - v0) * (u - u0) / (u1 - u0); }
  return points.at(-1)![1];
}
// Length quantiles of the live names (q0, q10, q50, q90, q99, max).
const ITEM_LEN: [number, number][] = [[0, 4], [0.1, 9], [0.5, 16], [0.9, 26], [0.99, 34], [1, 40]];
const CARD_LEN: [number, number][] = [[0, 8], [0.1, 15], [0.5, 21], [0.9, 28], [0.99, 34], [1, 40]];
const PROJECTS = ["Whitefoot", "Firn", "Halo", "Snowghost", "kit", "Architect"];
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const yaml = (v: unknown) => stringify(v, { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" });

type Kind = "item" | "decision" | "note";
interface Doc { kind: Kind; key: string; obj: any }
export type Layout = "flat" | "sharded";
const DIRS: Record<Kind, string> = { item: "items", decision: "decisions", note: "notes" };
function pathOf(layout: Layout, kind: Kind, key: string): string {
  return layout === "flat" ? `${DIRS[kind]}/${key}.yaml` : `${DIRS[kind]}/${createHash("sha1").update(key).digest("hex").slice(0, 2)}/${key}.yaml`;
}
interface Change { path: string; text: string; message: string }

class World {
  readonly r: Rng;
  readonly docs: Record<Kind, Doc[]> = { item: [], decision: [], note: [] };
  clock: number;
  readonly layout: Layout;
  constructor(layout: Layout, seed = 1) {
    this.layout = layout;
    this.r = new Rng(seed);
    this.clock = Date.now() - 7 * 86400_000;
    const r = this.r, used = new Set<string>(), at = iso(this.clock);
    const key = (len: number): string => {
      let k = "";
      while (k.length < len) k += (k ? "-" : "") + ASCII_WORDS[r.int(2500)]!;
      k = k.slice(0, Math.max(1, Math.round(len))).replace(/[-.]+$/, "");
      while (used.has(k)) k += "x";
      used.add(k);
      return k;
    };
    for (let n = 0; n < SCALE.items; n++) {
      const k = key(quantile(ITEM_LEN, r.next())), size = Math.min(103_000, Math.max(600, r.lognormal(4572, 1.0))), group = PROJECTS[n % PROJECTS.length]!;
      const log = Array.from({ length: Math.floor(size * 0.5 / 330) }, () => ({ at, by: group, text: text(r, 200 + r.int(200)) }));
      this.docs.item.push({ kind: "item", key: k, obj: { num: n + 1, title: `Item ${k}`, group, ...(n % 7 === 0 ? { priority: ["P0", "P1", "P2"][n % 3] } : {}), head: text(r, size * 0.5), log,
        plan: [{ id: "w", text: "work", state: ["doing", "done", "todo"][n % 3], ...(n % 3 === 0 ? { since: at } : n % 3 === 1 ? { doneAt: at } : {}) }, { id: "accept", text: "passes", state: "todo", accept: true }], created: at, updated: at, rev: 1 } });
    }
    for (let n = 0; n < SCALE.decisions; n++) {
      const k = key(quantile(CARD_LEN, r.next())), open = n % 3 !== 0, size = Math.max(500, r.lognormal(3053, 0.48));
      this.docs.decision.push({ kind: "decision", key: k, obj: { num: SCALE.items + n + 1, item: this.docs.item[(n * 7) % SCALE.items]!.key, question: `Question ${n}?`, background: text(r, size),
        options: [{ key: "A", text: "Do it", recommended: true }, { key: "B", text: "Do not" }], status: open ? "open" : "ruled", ...(open ? {} : { choice: "A", ruling: "A", ruledAt: at }), at, updated: at, rev: 1 } });
    }
    for (let n = 0; n < SCALE.notes; n++) {
      const k = Array.from({ length: 20 }, () => "0123456789abcdef"[r.int(16)]).join(""), done = n % 3 === 0, onCard = n % 2 === 0;
      this.docs.note.push({ kind: "note", key: k, obj: { target: onCard ? `q:${this.docs.decision[n % SCALE.decisions]!.key}` : `it:${this.docs.item[(n * 5) % SCALE.items]!.key}`, kind: onCard ? "choice" : "comment", ...(onCard ? { choice: "A" } : {}),
        text: text(r, Math.min(11_000, Math.max(40, r.lognormal(206, 1.4)))), at, state: done ? "done" : "sent", sentAt: at, ...(done ? { reply: "Handled", repliedAt: at, repliedBy: "Firn" } : {}), rev: 1 } });
    }
  }
  files(): [string, string][] {
    const out: [string, string][] = [];
    for (const kind of ["item", "decision", "note"] as Kind[]) for (const d of this.docs[kind]) out.push([pathOf(this.layout, kind, d.key), yaml(d.obj)]);
    out.push(["board.yaml", yaml({ title: "Synthetic board", projects: PROJECTS.map(name => ({ name })) })]);
    out.push(["numbers.yaml", yaml({ next: SCALE.items + SCALE.decisions + 1 })]);
    return out;
  }
  /** One write of the live mix: mostly an item (a log entry appended), sometimes a note or a card. */
  next(): Change {
    const r = this.r, u = r.next(), kind: Kind = u < 0.78 ? "item" : u < 0.90 ? "note" : "decision";
    const list = this.docs[kind], d = list[Math.floor(list.length * r.next() ** 2)]!, at = iso(this.clock += 30_000);
    d.obj.rev++;
    if (kind !== "note") d.obj.updated = at;
    if (kind === "item") d.obj.log.push({ at, by: d.obj.group, text: text(r, 150 + r.int(400)) });
    else if (kind === "decision") d.obj.background = d.obj.background.length > 12_000 ? text(r, 3000) : d.obj.background + text(r, 60);
    else { d.obj.state = "done"; d.obj.reply = text(r, 40 + r.int(200)); d.obj.repliedAt = at; d.obj.repliedBy = "Firn"; }
    return { path: pathOf(this.layout, kind, d.key), text: yaml(d.obj), message: `append_log ${d.key}` };
  }
  take(n: number): Change[] { return Array.from({ length: n }, () => this.next()); }
}

/** The first commit and the history, written by one fast-import: all of it lands in one pack, as an import does. */
function importHistory(dir: string, world: World, commits: number): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const stream = join(ROOT, `fi-${copies++}.stream`);
  writeFileSync(stream, "");
  let buf: string[] = [], mark = 0;
  const flush = () => { if (buf.length) { appendFileSync(stream, buf.join("")); buf = []; } };
  const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  const commit = (message: string, at: number, files: [string, string][]) => {
    mark++;
    buf.push(`commit refs/heads/main\nmark :${mark}\nauthor Study <study@example.invalid> ${Math.floor(at / 1000)} +0000\ncommitter wf-board <wf-board@wf-board.invalid> ${Math.floor(at / 1000)} +0000\n${data(message)}`);
    if (mark > 1) buf.push(`from :${mark - 1}\n`);
    for (const [p, t] of files) buf.push(`M 100644 inline ${p}\n${data(t)}`);
    if (buf.length > 2000) flush();
  };
  commit("Seed synthetic board", world.clock, world.files());
  for (let k = 0; k < commits; k++) { const c = world.next(); commit(c.message, world.clock, [[c.path, c.text]]); }
  flush();
  const fd = openSync(stream, "r");
  const r = spawnSync("git", ["fast-import", "--quiet"], { cwd: dir, env: GITENV, stdio: [fd, "inherit", "inherit"] });
  closeSync(fd);
  rmSync(stream);
  if (r.status !== 0) throw new Error("git fast-import failed");
  git(dir, ["reset", "-q", "--hard", "main"]);
}
/** The writes of the board's own path: write the file, git add, git commit (no automatic maintenance while generating). */
function applyChanges(dir: string, changes: Change[]): void {
  for (const c of changes) {
    mkdirSync(dirname(join(dir, c.path)), { recursive: true });
    writeFileSync(join(dir, c.path), c.text);
    git(dir, [...NO_AUTO, "add", "--", c.path]);
    git(dir, [...NO_AUTO, "commit", "-q", "-m", c.message]);
  }
}
const MAINT = [...FG, ...FORCE, "maintenance", "run", "--auto"];

interface Prepared { world: World; pre: string; base: string; ckpt: Map<number, string> }
/** Pack A (history), pack X (a small second pack), the loose objects of `preLoose` commits ("pre", the state before the gc of
 * 10-16), then that gc ("base"), then the loose objects of the requested numbers of commits on top of base. */
function prepare(layout: Layout, dirty: number[]): Prepared {
  const t0 = performance.now(), world = new World(layout);
  const pre = join(ROOT, `pre-${layout}`);
  importHistory(pre, world, SCALE.history);
  note(`replica ${layout}: history imported in ${f((performance.now() - t0) / 1000)} s; ${shape(pre)}`);
  // fast-import deltifies badly (a delta against the previous blob, whatever file it is), so its pack is several times the live pack;
  // -f redoes the deltas the way the live pack, made by git's own repack, has them (live: 27 MB for 88.5 thousand objects).
  const tA = performance.now();
  git(pre, ["repack", "-a", "-d", "-f", "-q"]);
  note(`replica ${layout}: pack A repacked with -f in ${f((performance.now() - tA) / 1000)} s; ${shape(pre)}`);
  applyChanges(pre, world.take(SCALE.packX));
  git(pre, MAINT);
  applyChanges(pre, world.take(SCALE.preLoose));
  note(`replica ${layout} "pre" (before the first gc): ${shape(pre)}; ${git(pre, ["rev-list", "--count", "HEAD"]).trim()} commits; built in ${f((performance.now() - t0) / 1000)} s`);
  const base = copyRepo(pre, `base-${layout}`);
  const m = timed(base, MAINT);
  note(`replica ${layout} "base" (after one forced maintenance of the pre state, ${f(m.ms)} ms): ${shape(base)}`);
  const ckpt = new Map<number, string>();
  let done = 0;
  const work = copyRepo(base, `dirty-${layout}`);
  for (const L of [...dirty].sort((a, b) => a - b)) {
    applyChanges(work, world.take(L - done));
    done = L;
    ckpt.set(L, copyRepo(work, `ckpt-${layout}-${L}`));
    note(`replica ${layout} checkpoint L=${L} commits on base: ${shape(ckpt.get(L)!)}`);
  }
  return { world, pre, base, ckpt };
}

// ---------------------------------------------------------------- trace2
function traceLines(file: string): string[] {
  const events = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l) as { event: string; sid: string; time: string; argv?: string[]; t_abs?: number; code?: number });
  const exits = new Map(events.filter(e => e.event === "exit").map(e => [e.sid, e]));
  return events.filter(e => e.event === "start").map(e => `${e.sid.split("/").length - 1}| ${(exits.get(e.sid)?.t_abs ?? NaN).toFixed(3)} s | ${(e.argv ?? []).slice(0, 12).join(" ")}`);
}

// ---------------------------------------------------------------- experiment: cost (calibration and the curve)
function cost(): void {
  const dirty = SMOKE ? [10, 20, 40] : [200, 400, 800, 1600, 2160, 3200, 4400];
  const { pre, ckpt } = prepare("flat", dirty);
  // 1. The trigger as the board meets it: a commit with git's own settings (threshold 6700), foreground; the control is the same commit with maintenance off.
  const rows: Record<string, unknown>[] = [], trig: number[] = [], ctrl: number[] = [];
  // git decides to run maintenance from the number of loose objects in one object directory (a sample); when the default threshold
  // (6700) does not fire on this copy, the threshold is lowered for all rounds, and the table says so.
  let lowered: string[] = [];
  for (let i = 0; i < ROUNDS(7); i++) {
    for (const mode of (i % 2 ? ["trigger", "control"] : ["control", "trigger"])) {
      const w = copyRepo(pre, "w");
      const trace = join(ROOT, `trace-${i}-${mode}.jsonl`);
      const before = counts(w);
      const args = mode === "trigger" ? [...FG, ...lowered, "commit", "--allow-empty", "-q", "-m", "trigger"] : [...NO_AUTO, "commit", "--allow-empty", "-q", "-m", "control"];
      const t = timed(w, args, i === 0 ? { GIT_TRACE2_EVENT: trace } : {});
      const after = counts(w);
      (mode === "trigger" ? trig : ctrl).push(t.ms);
      rows.push({ round: i, mode, ms: f(t.ms), looseBefore: before.count, looseAfter: after.count, packsAfter: after.packs, sizePackKB: after["size-pack"] });
      if (i === 0 && mode === "trigger") {
        console.log("trace2 of the trigger commit (depth| exit time | argv):\n" + traceLines(trace).join("\n"));
        if (after.count! >= before.count!) { lowered = ["-c", "gc.auto=2000"]; note("E0: the default threshold did not fire on this copy; later rounds use gc.auto=2000"); }
      }
      rmSync(w, { recursive: true, force: true });
    }
  }
  emit("E0 the first foreground maintenance on the pre state, vs the same commit without it", rows);
  note(`E0 summary: trigger median ${f(median(trig))} ms (range ${f(Math.min(...trig))}-${f(Math.max(...trig))}); control median ${f(median(ctrl))} ms; live: 5672 ms for 9087 loose objects (2160 commits).`);
  // 2. The curve: the forced maintenance on the base plus L commits.
  const curve: Record<string, unknown>[] = [];
  for (const L of dirty) {
    const ms: number[] = [];
    let before = counts(ckpt.get(L)!), after = before, triggered = 0;
    for (let i = 0; i < ROUNDS(5); i++) {
      const w = copyRepo(ckpt.get(L)!, "w");
      before = counts(w);
      const t = timed(w, MAINT);
      after = counts(w);
      if (after.count! < before.count! / 2) triggered++;
      ms.push(t.ms);
      rmSync(w, { recursive: true, force: true });
    }
    curve.push({ L, looseObjects: before.count, looseKB: before.size, KBperCommit: f(before.size / L, 1), medianMs: f(median(ms)), minMs: f(Math.min(...ms)), maxMs: f(Math.max(...ms)), msPerCommit: f(median(ms) / L, 2), packsAfter: after.packs, newPackKB: after["size-pack"]! - before["size-pack"]!, looseAfter: after.count, triggered: `${triggered}/${ROUNDS(5)}` });
  }
  emit("E1 forced maintenance on base + L loose commits (5 rounds, copies)", curve);
}

// ---------------------------------------------------------------- experiment: knobs
interface Variant { name: string; args: string[] }
function knobs(): void {
  const dirty = SMOKE ? [20, 40] : [800, 2160];
  const { ckpt } = prepare("flat", dirty);
  const variants: Variant[] = [
    { name: "default", args: MAINT },
    { name: "default-twin", args: MAINT },
    ...[5, 3, 2, 1, 0].map(w => ({ name: `window=${w}`, args: ["-c", `pack.window=${w}`, ...MAINT] })),
    { name: "threads=1", args: ["-c", "pack.threads=1", ...MAINT] },
    { name: "threads=2", args: ["-c", "pack.threads=2", ...MAINT] },
    { name: "window=3,depth=10", args: ["-c", "pack.window=3", "-c", "pack.depth=10", ...MAINT] },
    { name: "repack -d -l", args: ["repack", "-d", "-l", "-q"] },
    { name: "loose-objects task", args: ["maintenance", "run", "--task=loose-objects", "--quiet"] },
    { name: "geometric=2", args: ["repack", "-d", "-l", "--geometric=2", "--write-midx", "-q"] },
    { name: "geometric=2,window=3", args: ["-c", "pack.window=3", "repack", "-d", "-l", "--geometric=2", "--write-midx", "-q"] },
  ];
  for (const L of dirty) {
    const per = new Map<string, { ms: number[]; kb: number[]; looseAfter: number[]; packs: number[] }>(variants.map(v => [v.name, { ms: [], kb: [], looseAfter: [], packs: [] }]));
    for (let i = 0; i < ROUNDS(7); i++) {
      const order = [...variants].sort(() => Math.random() - 0.5);
      for (const v of order) {
        const w = copyRepo(ckpt.get(L)!, "w"), before = counts(w), t = timed(w, v.args), after = counts(w), p = per.get(v.name)!;
        p.ms.push(t.ms); p.kb.push(after["size-pack"]! - before["size-pack"]!); p.looseAfter.push(after.count); p.packs.push(after.packs);
        rmSync(w, { recursive: true, force: true });
      }
    }
    const base = per.get("default")!.ms, twin = ratioCi(per.get("default-twin")!.ms, base);
    note(`E2 L=${L}: noise = twin/base ratio ${f(twin.ratio, 3)} (95% ${f(twin.lo, 3)}-${f(twin.hi, 3)}), half-width ${f(100 * twin.half, 1)} %`);
    emit(`E2 knobs at L=${L} commits (${ROUNDS(7)} rounds, interleaved, same copies)`, variants.map(v => {
      const p = per.get(v.name)!, rc = ratioCi(p.ms, base);
      return { variant: v.name, medianMs: f(median(p.ms)), minMs: f(Math.min(...p.ms)), maxMs: f(Math.max(...p.ms)), ratioToDefault: `${f(rc.ratio, 2)} (${f(rc.lo, 2)}-${f(rc.hi, 2)})`, newPackKB: f(median(p.kb)), looseAfter: f(median(p.looseAfter)), packsAfter: f(median(p.packs)) };
    }));
  }
}

// ---------------------------------------------------------------- experiment: packs (accumulation and merging)
function readBench(dir: string): Record<string, number> {
  const files = git(dir, ["ls-tree", "-r", "HEAD", "--", "items"]).trim().split("\n");
  const rnd = new Rng(99), oids: string[] = [];
  for (let i = 0; i < 2000; i++) oids.push(files[rnd.int(files.length)]!.split(/\s+/)[2]!);
  const out: Record<string, number> = {};
  const run = (name: string, args: string[], input?: string) => {
    const ms: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = spawnSync("git", args, { cwd: dir, env: GITENV, input, encoding: "utf8", maxBuffer: 1 << 30 });
      ms.push(performance.now() - t0);
      if (r.status !== 0) throw new Error(`${name}: ${r.stderr}`);
    }
    out[name] = median(ms);
  };
  run("revListCount", ["rev-list", "--count", "HEAD"]);
  run("catFile2000", ["cat-file", "--batch"], oids.join("\n") + "\n");
  run("logPath200", ["log", "--format=%H", "-n", "200", "--", files[0]!.split("\t")[1]!]);
  run("diffTree", ["diff-tree", "-r", "--name-only", "HEAD~50", "HEAD"]);
  return out;
}
/** Packs of at least this many bytes get a .keep file, so a geometric repack never rewrites them. */
function keepBig(dir: string, bytes: number): number {
  const packDir = join(dir, ".git/objects/pack");
  let kept = 0;
  for (const name of readdirSync(packDir)) if (name.endsWith(".pack") && statSync(join(packDir, name)).size >= bytes) { writeFileSync(join(packDir, name.replace(/\.pack$/, ".keep")), ""); kept++; }
  return kept;
}
const GRAPH = ["commit-graph", "write", "--split", "--reachable", "--no-progress"];
function packs(wanted?: string): void {
  const TOTAL = SMOKE ? 60 : 12000, STEPS = SMOKE ? [10] : [100, 300];
  const KEEP_MB = Number(process.env.STUDY_KEEP_MB ?? (SMOKE ? 1 : 8));
  const MERGE_MB = Number(process.env.STUDY_MERGE_MB ?? (SMOKE ? 1 : 16));
  const { world, base } = prepare("flat", []);
  const changes = world.take(TOTAL);
  // Each strategy maintains after every STEP commits.
  const all: Record<string, { name: string; step: (dir: string, k: number) => number }> = {
    geo: { name: "geometric=2 (what git's own auto maintenance runs)", step: dir => timed(dir, ["repack", "-d", "-l", "--geometric=2", "--write-midx", "-q"]).ms + timed(dir, GRAPH).ms },
    keep: { name: `geometric=2, packs of ${KEEP_MB} MB and more kept (.keep)`, step: (dir, k) => {
      keepBig(dir, KEEP_MB * 1048576);
      const trace = join(ROOT, `trace-keep-${k}.jsonl`);
      const r = timed(dir, ["repack", "-d", "-l", "--geometric=2", "--write-midx", "-q"], k === 3 || k === 60 ? { GIT_TRACE2_EVENT: trace } : {}).ms, g = timed(dir, GRAPH).ms;
      if (k === 3 || k === 60) {
        const packDir = join(dir, ".git/objects/pack");
        note(`E3 keep variant, step ${k}: repack ${f(r)} ms, commit-graph ${f(g)} ms; packs: ${readdirSync(packDir).filter(n => n.endsWith(".pack") || n.endsWith(".keep")).map(n => n.slice(5, 11) + n.slice(-5) + (n.endsWith(".pack") ? ":" + f(statSync(join(packDir, n)).size / 1048576, 1) + "MB" : "")).join(" ")}\ntrace2 (depth| exit time | argv):\n` + traceLines(trace).join("\n"));
      }
      return r + g;
    } },
    midx: { name: `pack the loose objects, then merge small packs in batches of ${MERGE_MB} MB (multi-pack-index repack)`, step: dir => {
      let ms = timed(dir, ["repack", "-d", "-l", "--write-midx", "-q"]).ms + timed(dir, GRAPH).ms;
      if (counts(dir).packs > 8) ms += timed(dir, ["multi-pack-index", "expire", "--no-progress"]).ms + timed(dir, ["multi-pack-index", "repack", `--batch-size=${MERGE_MB}m`, "--no-progress"]).ms;
      return ms;
    } },
  };
  const strategies = (wanted ? wanted.split(",") : ["geo", "keep", "midx"]).map(k => all[k]!);
  const ends: [string, string][] = [];
  for (const STEP of STEPS) for (const s of strategies) {
    const w = copyRepo(base, "strat"), ms: number[] = [], rows: Record<string, unknown>[] = [];
    for (let k = 0; k < TOTAL / STEP; k++) {
      applyChanges(w, changes.slice(k * STEP, (k + 1) * STEP));
      const before = counts(w), t = s.step(w, k), after = counts(w);
      ms.push(t);
      rows.push({ step: k + 1, ms: f(t), looseBefore: before.count, packsAfter: after.packs, sizePackKB: after["size-pack"], looseAfter: after.count });
    }
    const sorted = [...ms].sort((a, b) => a - b), med = median(ms);
    emit(`E3 ${s.name}, every ${STEP} commits: the steps over twice the median (${f(med)} ms), of ${ms.length}`, rows.filter(r => Number(r.ms) > 2 * med));
    note(`E3 ${s.name}, every ${STEP} commits: ${ms.length} steps, median ${f(med)} ms, p95 ${f(sorted[Math.floor(sorted.length * 0.95)]!)} ms, max ${f(sorted.at(-1)!)} ms, sum ${f(ms.reduce((a, b) => a + b, 0) / 1000)} s; end state ${shape(w)}; max packs seen ${Math.max(...rows.map(r => Number(r.packsAfter)))}`);
    ends.push([`${s.name} / ${STEP}`, w]);
  }
  const full = copyRepo(base, "full");
  note(`E3 full repack of base (repack -a -d -f --write-midx): ${f(timed(full, ["repack", "-a", "-d", "-q", "--write-midx"]).ms)} ms; same without a rewrite of deltas, repack -a -d: see above`);
  const reads: Record<string, unknown>[] = [{ state: "base", packs: counts(base).packs, ...Object.fromEntries(Object.entries(readBench(base)).map(([k, v]) => [k, f(v, 1)])) }];
  for (const [name, dir] of ends) reads.push({ state: name, packs: counts(dir).packs, ...Object.fromEntries(Object.entries(readBench(dir)).map(([k, v]) => [k, f(v, 1)])) });
  emit("E3 read commands (median ms of 3) by end state", reads);
}

// ---------------------------------------------------------------- experiment: shard (the layout as the root of the cost)
function shard(): void {
  const dirty = SMOKE ? [20, 40] : [800, 2160];
  const layouts: Layout[] = ["flat", "sharded"], ck = new Map(layouts.map(l => [l, prepare(l, dirty).ckpt]));
  for (const L of dirty) {
    const per = new Map<Layout, { ms: number[]; before: Record<string, number>; after: Record<string, number> }>(layouts.map(l => [l, { ms: [], before: {}, after: {} }]));
    for (let i = 0; i < ROUNDS(5); i++) for (const l of (i % 2 ? [...layouts].reverse() : layouts)) {
      const w = copyRepo(ck.get(l)!.get(L)!, "w"), p = per.get(l)!;
      p.before = counts(w);
      p.ms.push(timed(w, MAINT).ms);
      p.after = counts(w);
      rmSync(w, { recursive: true, force: true });
    }
    emit(`E5 layout at L=${L} commits on base`, layouts.map(l => { const p = per.get(l)!; return { layout: l, looseObjects: p.before.count, looseKB: p.before.size, objectsPerCommit: f(p.before.count! / L, 1), KBperCommit: f(p.before.size! / L, 1), medianMs: f(median(p.ms)), msPerCommit: f(median(p.ms) / L, 2), newPackKB: p.after["size-pack"]! - p.before["size-pack"]! }; }));
  }
}


// ---------------------------------------------------------------- experiment: replay (write latency under a policy)
// The real Store writes at the rate of the busiest ten minutes of the live board (1566 commits in 595 s: gaps under 1 s for 69%,
// 1 to 2 s for 30%), while a policy decides when maintenance runs. Maintenance is a task of the Store's own write queue, so a write
// that arrives during it waits, as it would in the daemon. Latency is measured from the write's submission to its answer.
interface PolicyDef { name: string; config: [string, string][]; start: number; push?: boolean; adaptive?: boolean; idleMs?: number; idleMin?: number; max?: number }
const POLICIES: PolicyDef[] = [
  { name: "git-default", config: [], start: 0 },
  { name: "git-g500", config: [["gc.auto", "500"]], start: 0 },
  { name: "count-100", config: [["gc.auto", "0"], ["maintenance.auto", "false"]], start: 100 },
  { name: "count-200", config: [["gc.auto", "0"], ["maintenance.auto", "false"]], start: 200 },
  { name: "count-300", config: [["gc.auto", "0"], ["maintenance.auto", "false"]], start: 300 },
  { name: "count-200-push", config: [["gc.auto", "0"], ["maintenance.auto", "false"]], start: 200, push: true },
  { name: "count-400", config: [["gc.auto", "0"], ["maintenance.auto", "false"]], start: 400 },
  { name: "adaptive", config: [["gc.auto", "0"], ["maintenance.auto", "false"]], start: 200, adaptive: true },
  { name: "idle", config: [["gc.auto", "0"], ["maintenance.auto", "false"]], start: 400, idleMs: 3000, idleMin: 50, max: 800 },
];
// The board's own maintenance step: git's geometric repack of the small packs and the loose objects (what git's auto maintenance runs), the
// commit-graph, and big packs kept out of the repack (STUDY_KEEP_MB, 0: none).
const REPLAY_KEEP_MB = Number(process.env.STUDY_KEEP_MB ?? (SMOKE ? 1 : 8));
const REPLAY_STEP = process.env.STUDY_STEP ?? "midx";
const REPLAY_MERGE_MB = Number(process.env.STUDY_MERGE_MB ?? (SMOKE ? 1 : 16));
/** One maintenance step, as a list of git commands (the board runs them one after another inside its write queue). */
function stepCommands(dir: string): string[][] {
  if (REPLAY_STEP === "geo") return [["repack", "-d", "-l", "--geometric=2", "--write-midx", "-q"], GRAPH];
  if (REPLAY_STEP === "keep") { if (REPLAY_KEEP_MB > 0) keepBig(dir, REPLAY_KEEP_MB * 1048576); return [["repack", "-d", "-l", "--geometric=2", "--write-midx", "-q"], GRAPH]; }
  const cmds = [["repack", "-d", "-l", "--write-midx", "-q"], GRAPH];
  if (counts(dir).packs > 8) cmds.push(["multi-pack-index", "expire", "--no-progress"], ["multi-pack-index", "repack", `--batch-size=${REPLAY_MERGE_MB}m`, "--no-progress"]);
  return cmds;
}
async function replay(name: string): Promise<void> {
  const def = POLICIES.find(p => p.name === name);
  if (!def) throw new Error("unknown policy " + name);
  const PUSH = def.push === true || process.env.STUDY_PUSH === "1";
  const { Store } = await import("../../src/store.ts");
  const { world, base } = prepare("flat", []);
  const dir = copyRepo(base, "replay");
  // The live repository right after the gc of 10-16: its packs are a geometric ladder, and 859 commits (3557 loose objects) have come since.
  // The synthetic base has packs that still break the ladder; one geometric repack makes it consistent.
  timed(dir, ["repack", "-d", "-l", "--geometric=2", "--write-midx", "-q"]);
  applyChanges(dir, world.take(SMOKE ? 20 : 859));
  for (const [k, v] of def.config) git(dir, ["config", k, v]);
  note(`replay start state, as the live repository was on 10-17: ${shape(dir)}`);
  const remote = join(ROOT, "remote.git");
  if (PUSH) { git(ROOT, ["init", "-q", "--bare", remote]); git(dir, ["remote", "add", "origin", remote]); git(dir, ["push", "-q", "origin", "main"]); }
  const trace = join(ROOT, "trace2.jsonl");
  process.env.GIT_TRACE2_EVENT = trace;
  GITENV.GIT_TRACE2_EVENT = trace;
  // A board with a maintenance policy of its own finds the backlog at start and works it off before it takes writes.
  const catchUp: number[] = [];
  if (def.start > 0) while (Math.floor(counts(dir).count / 4) >= def.start) {
    const t = performance.now();
    for (const cmd of stepCommands(dir)) git(dir, cmd);
    catchUp.push(performance.now() - t);
  }
  if (catchUp.length) note(`E4 ${def.name}: the start works off the backlog in ${catchUp.length} step(s) of ${catchUp.map(x => f(x)).join(", ")} ms; then ${shape(dir)}`);
  const store = await Store.open(dir);
  const q = store as unknown as { enqueue<T>(fn: () => Promise<T>): Promise<T>; git(args: string[]): Promise<string> };
  const r = new Rng(4242), keys = Object.keys(store.snapshot().items);
  const N = SMOKE ? 60 : 1566;
  const bins: [number, number, number][] = [[0, 1, 1075], [1, 2, 470], [2, 3, 5], [3, 5, 5], [5, 10, 6], [10, 15, 4]], total = bins.reduce((a, b) => a + b[2], 0);
  const gap = (): number => { let u = r.next() * total; for (const [lo, hi, w] of bins) { if (u < w) return (lo + (hi - lo) * r.next()) * (SMOKE ? 100 : 1000); u -= w; } return 500; };
  const lat: number[] = [], maint: { at: number; ms: number; commits: number }[] = [], slow: string[] = [];
  let since = def.start > 0 ? Math.floor(counts(dir).count / 4) : 0, pending = false, nextAt = def.start, msPerCommit = 3, idleTimer: NodeJS.Timeout | undefined, pushes = 0, pushErrors = 0;
  const t0 = performance.now();
  const requestMaint = () => {
    if (pending) return;
    pending = true;
    void q.enqueue(async () => {
      const a = performance.now(), n = since;
      for (const cmd of stepCommands(dir)) await q.git(cmd);
      const ms = performance.now() - a;
      maint.push({ at: a - t0, ms, commits: n });
      since -= n; pending = false;
      if (def.adaptive && n > 0) { msPerCommit = 0.5 * msPerCommit + 0.5 * (ms / n); nextAt = Math.max(50, Math.min(2000, Math.floor(1000 / msPerCommit))); }
    });
  };
  const afterWrite = () => {
    since++;
    if (def.start > 0 && since >= (def.adaptive ? nextAt : def.start)) requestMaint();
    if (def.idleMs) { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (since >= def.idleMin!) requestMaint(); }, def.idleMs); if (since >= def.max!) requestMaint(); }
  };
  const writes: Promise<void>[] = [];
  let pushTimer: NodeJS.Timeout | undefined;
  if (PUSH) pushTimer = setInterval(() => { pushes++; store.push().catch(() => { pushErrors++; }); }, SMOKE ? 500 : 3000);
  let at = 0;
  for (let i = 0; i < N; i++) {
    at += gap();
    const wait = t0 + at - performance.now();
    if (wait > 0) await new Promise(ok => setTimeout(ok, wait));
    const id = keys[Math.floor(keys.length * r.next() ** 2)]!, sent = performance.now();
    writes.push((async () => {
      // A write that lost a race for the same item reads it again, as the board's callers do.
      for (let attempt = 0; ; attempt++) {
        const it = store.snapshot().items[id]!, { rev, ...rest } = it as typeof it & { rev: number }, stamp = iso(Date.now());
        try {
          await store.commit({ author: it.group, message: `append_log ${id}`, session: "study", puts: [{ kind: "item", id, expectRev: rev, doc: { ...rest, log: [...rest.log, { at: stamp, by: it.group, text: text(r, 300) }], updated: stamp } }] });
          break;
        } catch (error) {
          if (attempt >= 20 || !String(error).includes("expected rev")) throw error;
        }
      }
      lat.push(performance.now() - sent);
      afterWrite();
    })());
  }
  await Promise.all(writes);
  clearTimeout(idleTimer); clearInterval(pushTimer);
  await q.enqueue(async () => {});
  const sorted = [...lat].sort((a, b) => a - b), pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  // The trace: does any git add start while a maintenance process runs?
  const events = readFileSync(trace, "utf8").trimEnd().split("\n").map(l => JSON.parse(l) as { event: string; sid: string; time: string; argv?: string[] });
  const exitTime = (sid: string, from: string) => events.find(e => e.event === "exit" && e.sid === sid && e.time >= from)?.time ?? "￿";
  const procs = events.filter(e => e.event === "start" && e.argv?.some(a => a === "maintenance" || a === "repack")).map(e => ({ from: e.time, to: exitTime(e.sid, e.time) }));
  // Every maintenance process the trace saw: when it began (seconds from the first event), how long it lasted, and how many commits came before it.
  const firstTime = events[0]!.time, secs = (a: string, b: string) => (Date.parse(a.replace(/\.(\d+)Z?$/, (_, d: string) => "." + d.slice(0, 3) + "Z")) - Date.parse(b.replace(/\.(\d+)Z?$/, (_, d: string) => "." + d.slice(0, 3) + "Z"))) / 1000;
  const commitStarts = events.filter(e => e.event === "start" && e.argv?.includes("commit")).map(e => e.time);
  const seen = events.filter(e => e.event === "start" && e.argv?.some(a => a === "maintenance" || a === "repack")).map(e => ({ argv: (e.argv ?? []).filter(a => !a.startsWith("-c")).slice(0, 5).join(" "), from: e.time, to: exitTime(e.sid, e.time) }));
  note(`E4 ${def.name}: maintenance processes in the trace (start s / duration s / commits before): ${seen.filter(m => (m.argv.includes("repack") || m.argv.includes("maintenance")) && (m.to === "\uffff" || secs(m.to, m.from) >= 0.05)).map(m => `${f(secs(m.from, firstTime), 1)}/${m.to < "\uffff" ? f(secs(m.to, m.from), 2) : "?"}/${commitStarts.filter(c => c < m.from).length} [${m.argv.slice(-30)}]`).join("  ")}`);
  const adds = events.filter(e => e.event === "start" && e.argv?.includes("add")).map(e => e.time);
  const overlaps = adds.filter(a => procs.some(m => a >= m.from && a < m.to)).length;
  const after = counts(dir);
  emit(`E4 replay, policy ${def.name}, ${N} writes at the busiest ten minutes' rhythm${PUSH ? ", with a push every 3 s" : ""}`, [{
    policy: def.name, writes: N, p50: f(pct(0.5)), p90: f(pct(0.9)), p99: f(pct(0.99)), max: f(sorted.at(-1)!), over1s: lat.filter(x => x > 1000).length, over3s: lat.filter(x => x > 3000).length,
    maintRuns: maint.length, maintMaxMs: f(Math.max(0, ...maint.map(m => m.ms))), maintMedianMs: f(median(maint.map(m => m.ms))), maintTotalMs: f(maint.reduce((a, m) => a + m.ms, 0)), maintCommits: maint.map(m => m.commits).join("/"),
    looseEnd: after.count, packsEnd: after.packs, gitAddsDuringMaintenance: overlaps, pushes, pushErrors,
  }]);
  if (PUSH) {
    git(dir, ["fsck", "--no-dangling"]);
    note(`E6 after the run: git fsck passed; remote head is an ancestor of the local head: ${spawnSync("git", ["merge-base", "--is-ancestor", git(remote, ["rev-parse", "main"]).trim(), "HEAD"], { cwd: dir, env: GITENV }).status === 0}`);
  }
  note(`E4 ${def.name}: maintenance runs (at s, ms, commits): ${maint.map(m => `${f(m.at / 1000)}/${f(m.ms)}/${m.commits}`).join(" ")}`);
}

// ---------------------------------------------------------------- experiment: growth (a larger board)
function growth(): void {
  const dirty = SMOKE ? [10, 20] : [100, 200, 400];
  const { ckpt } = prepare("flat", dirty);
  const rows: Record<string, unknown>[] = [];
  for (const L of dirty) {
    const ms: number[] = [];
    let before = counts(ckpt.get(L)!);
    for (let i = 0; i < ROUNDS(5); i++) {
      const w = copyRepo(ckpt.get(L)!, "w");
      before = counts(w);
      ms.push(stepCommands(w).reduce((a, cmd) => a + timed(w, cmd).ms, 0));
      rmSync(w, { recursive: true, force: true });
    }
    rows.push({ boardSize: `x${GROW}`, documents: SCALE.items + SCALE.decisions + SCALE.notes, itemsTreeBytes: git(ckpt.get(L)!, ["cat-file", "-s", "HEAD:items"]).trim(), L, looseObjects: before.count, KBperCommit: f(before.size! / L, 1), medianMs: f(median(ms)), minMs: f(Math.min(...ms)), maxMs: f(Math.max(...ms)), msPerCommit: f(median(ms) / L, 2) });
  }
  emit(`E7 one maintenance step on a board ${GROW} times the live one's size (the board's step: repack -d -l, commit-graph)`, rows);
}

const command = process.argv[2];
note(`gc-study ${command}${SMOKE ? " (smoke)" : ""}; git ${git(ROOT, ["--version"]).trim()}; ${process.platform} ${process.arch}; cpus ${cpus().length}; scratch ${ROOT}`);
if (command === "cost") cost();
else if (command === "knobs") knobs();
else if (command === "packs") packs(process.argv[3]);
else if (command === "shard") shard();
else if (command === "replay") await replay(process.argv[3]!);
else if (command === "growth") growth();
else throw new Error("usage: gc-study.ts cost|knobs|packs|shard");
if (process.env.STUDY_KEEP !== "1") rmSync(ROOT, { recursive: true, force: true });
