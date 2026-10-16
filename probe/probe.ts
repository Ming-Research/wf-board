// Temporary probe for the study push-blocks-writes-study; removed before the branch is finished.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Store } from "../src/store.ts";

const exec = promisify(execFile);
const fakessh = join(import.meta.dirname, "fakessh.sh");
const at = "2026-10-16T01:02:03Z";
const item = (n: number) => ({ title: `Item ${n}`, group: "Test", head: "h".repeat(200), plan: [{ id: "accept", text: "Accepted", state: "todo" as const, accept: true as const }], priority: "P1" as const, updated: at });
const sh = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
const ms = (t0: number) => Math.round(performance.now() - t0);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const out = (label: string, value: unknown) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
let counter = 0;
const commit = (store: Store) => { const n = ++counter; return store.commit({ author: "probe", message: `Write ${n}`, puts: [{ kind: "item", id: `i${n}`, doc: item(n), expectRev: null }] }); };

/** A board and a bare remote reached through the fake ssh, with its first push already done. */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "probe-"));
  const remote = join(base, "remote.git");
  await mkdir(remote); await sh(remote, "init", "-q", "--bare", "-b", "main");
  const dir = join(base, "data");
  await mkdir(dir);
  const store = await Store.open(dir, { init: true, board: { title: "Probe", projects: [{ name: "Test" }] } });
  await sh(dir, "remote", "add", "origin", `ssh://fake${remote}`);
  process.env.GIT_SSH_COMMAND = fakessh;
  // The wrapper is not ssh: tell git so, or it runs the wrapper with -G first to find out.
  process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "ssh.variant"; process.env.GIT_CONFIG_VALUE_0 = "simple";
  delete process.env.PROBE_DELAY; delete process.env.PROBE_STALL_ON;
  await store.push();
  for (let i = 0; i < 3; i++) await commit(store);
  return { base, dir, remote, store };
}
const strays = async () => Number((await exec("sh", ["-c", "pgrep -f '[f]akessh.sh|[s]leep 3600' | wc -l"])).stdout.trim());
const killStrays = () => exec("sh", ["-c", "pkill -f '[f]akessh.sh|[s]leep 3600' || true"]);
const capped = <T>(p: Promise<T>, capMs: number) => Promise.race([p.then(() => "done" as const), sleep(capMs).then(() => "pending" as const)]);

/** P1: today's store.push() in the write queue. A write issued 300 ms into a push waits for it. */
async function p1() {
  const f0 = await fixture();
  const quiet: number[] = [];
  for (let i = 0; i < 20; i++) { const t0 = performance.now(); await commit(f0.store); quiet.push(ms(t0)); }
  out("p1 write alone ms", { median: median(quiet), max: Math.max(...quiet), all: quiet });
  for (const sc of [
    { name: "each connection 1.2 s (about today's network)", env: { PROBE_DELAY: "1.2" }, cap: 30000 },
    { name: "each connection 3 s", env: { PROBE_DELAY: "3" }, cap: 30000 },
    { name: "the push connection never answers", env: { PROBE_STALL_ON: "receive-pack" }, cap: 20000 },
    { name: "the first connection (ls-remote) never answers", env: { PROBE_STALL_ON: "upload-pack" }, cap: 20000 },
  ]) {
    const f = await fixture();
    Object.assign(process.env, sc.env);
    const t0 = performance.now();
    let pushEnd = -1, pushError = "";
    const push = f.store.push().then(() => { pushEnd = ms(t0); }, e => { pushEnd = ms(t0); pushError = String(e).slice(0, 80); });
    await sleep(300);
    const w0 = performance.now();
    const state = await capped(commit(f.store), sc.cap);
    out(`p1 ${sc.name}`, { write: state, writeWaitedMs: state === "done" ? ms(w0) : `>${sc.cap}`, pushEndedAtMs: pushEnd >= 0 ? pushEnd : "not yet", pushError });
    delete process.env.PROBE_DELAY; delete process.env.PROBE_STALL_ON;
    await killStrays(); await Promise.race([push, sleep(5000)]);
  }
}

/** The candidate: one git push of the head, outside the queue, maintenance off, killable. */
async function pushOutside(store: Store, dir: string, signal?: AbortSignal) {
  const head = store.snapshot().head;
  const r = await exec("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "push", "--porcelain", "origin", `${head}:refs/heads/main`], { cwd: dir, signal, killSignal: "SIGTERM" }).catch(e => ({ stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e), code: e.code ?? e.name }));
  return r;
}

/** P5: the push outside the queue. The write does not wait; an abort ends the push and its ssh child. */
async function p5() {
  for (const sc of [
    { name: "each connection 1.2 s", env: { PROBE_DELAY: "1.2" } },
    { name: "push connection never answers", env: { PROBE_STALL_ON: "receive-pack" } },
  ]) {
    const f = await fixture();
    Object.assign(process.env, sc.env);
    const ac = new AbortController();
    const t0 = performance.now();
    let pushEnd = -1;
    const push = pushOutside(f.store, f.dir, ac.signal).then(r => { pushEnd = ms(t0); return r; });
    await sleep(300);
    const lat: number[] = [];
    for (let i = 0; i < 5; i++) { const w0 = performance.now(); await commit(f.store); lat.push(ms(w0)); }
    out(`p5 ${sc.name}`, { writesDuringPushMs: lat, pushStillRunning: pushEnd < 0, strays: await strays() });
    if (sc.env.PROBE_STALL_ON) {
      const a0 = performance.now(); ac.abort(); await push;
      const ended = ms(a0);
      await sleep(500);
      out("p5 after abort (SIGTERM to git)", { pushEndedAfterMs: ended, straysLeft: await strays() });
    } else { const r = await push; out("p5 push result", { endedAtMs: pushEnd, stdout: (r as { stdout: string }).stdout.split("\n").slice(1, 2) }); }
    delete process.env.PROBE_DELAY; delete process.env.PROBE_STALL_ON; await killStrays();
  }
  // Kill semantics: does killing git end the ssh child?
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    const f = await fixture();
    process.env.PROBE_STALL_ON = "receive-pack";
    const child = spawn("git", ["push", "origin", `${f.store.snapshot().head}:refs/heads/main`], { cwd: f.dir, stdio: "ignore" });
    await sleep(1500);
    const before = await strays();
    child.kill(sig); await sleep(1000);
    out(`p5 kill ${sig}`, { straysBefore: before, straysAfter: await strays() });
    delete process.env.PROBE_STALL_ON; await killStrays();
  }
}

/** P4: what one git push says in each state, and whether it repairs a stale tracking ref. */
async function p4() {
  const f = await fixture();
  const head = () => f.store.snapshot().head;
  const push = async () => { const r = await exec("git", ["push", "--porcelain", "origin", `${head()}:refs/heads/main`], { cwd: f.dir }).then(r => ({ rc: 0, o: r.stdout }), e => ({ rc: e.code, o: String(e.stdout) })); return { rc: r.rc, status: r.o.split("\n").filter(l => /^[ *=!+-]\t/.test(l)).map(l => l.replace(/\s+/g, " ")) }; };
  out("p4 git version", await sh(f.dir, "--version"));
  out("p4 local ahead", await push());
  out("p4 up to date", await push());
  await sh(f.dir, "update-ref", "refs/remotes/origin/main", (await sh(f.dir, "rev-parse", "HEAD~2")));
  out("p4 tracking ref stale, remote up to date", await push());
  out("p4 tracking ref healed", (await sh(f.dir, "rev-parse", "refs/remotes/origin/main")) === head());
  const other = join(f.base, "other"); await sh(f.base, "clone", "-q", `${f.remote}`, other);
  await sh(other, "-c", "user.name=o", "-c", "user.email=o@x.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "elsewhere");
  await sh(other, "push", "-q", "origin", "main");
  out("p4 remote has a commit we lack, we have nothing new", await push());
  await commit(f.store);
  out("p4 remote has a commit we lack and we have new ones (diverged)", await push());
}

/** P3a: which git commands start maintenance, with and without the switches. */
async function p3a() {
  const f = await fixture();
  await sh(f.dir, "config", "gc.auto", "1");
  const trace = join(f.base, "trace.json");
  const started = async (label: string, gitArgs: string[]) => {
    await writeFile(trace, "");
    await exec("git", gitArgs, { cwd: f.dir, env: { ...process.env, GIT_TRACE2_EVENT: trace } }).catch(() => {});
    await sleep(300);
    const n = (await readFile(trace, "utf8")).split("\n").filter(l => /"argv":\["[^"]*","maintenance","run","--auto"/.test(l)).length;
    out(`p3a ${label}`, n > 0 ? "maintenance run --auto started" : "no maintenance");
  };
  const off = ["-c", "maintenance.auto=false", "-c", "gc.auto=0"];
  for (let i = 0; i < 4; i++) await commit(f.store);
  await started("git push (default)", ["push", "-q", "origin", `${f.store.snapshot().head}:refs/heads/main`]);
  await commit(f.store);
  await started("git push with maintenance off", [...off, "push", "-q", "origin", `${f.store.snapshot().head}:refs/heads/main`]);
  await started("git fetch (default)", ["fetch", "-q", "--no-tags", "origin", "refs/heads/main"]);
  await started("git fetch with maintenance off", [...off, "fetch", "-q", "--no-tags", "origin", "refs/heads/main"]);
  await started("git ls-remote (default)", ["ls-remote", "--heads", "origin", "refs/heads/main"]);
  await commit(f.store);
  await started("git commit (default)", ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"]);
}

/** P3b: commits through the store while pushes run outside the queue, with automatic maintenance firing on every commit. */
async function p3b() {
  for (const v of [
    { name: "push default, commits detached maintenance", pushArgs: [] as string[], detach: true },
    { name: "push maintenance off, commits detached maintenance", pushArgs: ["-c", "maintenance.auto=false", "-c", "gc.auto=0"], detach: true },
    { name: "push maintenance off, commits foreground maintenance", pushArgs: ["-c", "maintenance.auto=false", "-c", "gc.auto=0"], detach: false },
    { name: "push default, everything foreground maintenance", pushArgs: [] as string[], detach: false },
  ]) {
    const f = await fixture();
    await sh(f.dir, "config", "gc.auto", "1");
    if (!v.detach) { await sh(f.dir, "config", "gc.autoDetach", "false"); await sh(f.dir, "config", "maintenance.autoDetach", "false"); }
    let stop = false, pushes = 0; const errors: string[] = [];
    const pusher = (async () => { while (!stop) { try { await exec("git", [...v.pushArgs, "push", "-q", "origin", `${f.store.snapshot().head}:refs/heads/main`], { cwd: f.dir }); pushes++; } catch (e) { errors.push("push: " + String((e as { stderr?: string }).stderr ?? e).slice(0, 160)); } await sleep(50); } })();
    let commits = 0; const t0 = performance.now(); const lat: number[] = [];
    while (performance.now() - t0 < 40000) { const w0 = performance.now(); try { await commit(f.store); commits++; lat.push(ms(w0)); } catch (e) { errors.push("commit: " + String(e).slice(0, 160)); } }
    stop = true; await pusher;
    const fsck = await exec("git", ["fsck", "--strict"], { cwd: f.dir }).then(() => "ok", e => String(e.stderr).slice(0, 200));
    const remoteHead = await sh(f.remote, "rev-parse", "main");
    const counts = Object.fromEntries((await sh(f.dir, "count-objects", "-v")).split("\n").map(l => l.split(": ")).filter(([k]) => k === "count" || k === "packs"));
    out(`p3b ${v.name}`, { commits, pushes, errors: errors.length, firstErrors: errors.slice(0, 3), fsck, remoteHeadIsAncestorOfLocal: await sh(f.dir, "merge-base", "--is-ancestor", remoteHead, "HEAD").then(() => true, () => false), localObjects: counts, commitMedianMs: median(lat), commitMaxMs: Math.max(...lat) });
  }
}

/** P6: real ssh against a TCP server that accepts and never speaks. */
async function p6() {
  const server = createServer(() => {}); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  for (const opts of [["-o", "ConnectTimeout=5"], [] as string[]]) {
    const t0 = performance.now();
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", ...opts, "-p", String(port), "127.0.0.1", "true"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; child.stderr.on("data", d => { err += d; });
    const ended = await Promise.race([new Promise<string>(r => child.on("exit", c => r(`exited ${c}`))), sleep(25000).then(() => { child.kill("SIGKILL"); return "still running at 25 s, killed"; })]);
    out(`p6 ssh ${opts.join(" ") || "(no options)"} to a silent server`, { result: ended, afterMs: ms(t0), stderr: err.trim().split("\n").pop() });
  }
  server.close();
}

const which = process.argv[2];
const all = { p1, p3a, p3b, p4, p5, p6 } as const;
try {
  if (which === "all") for (const [name, fn] of Object.entries(all)) { console.log(`=== ${name}`); await fn(); }
  else await all[which as keyof typeof all]();
} finally { await killStrays().catch(() => {}); }
process.exit(0);
