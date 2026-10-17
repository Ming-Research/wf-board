// The deploy job (docs/design.md, Running): src/deploy.ts over real git repositories (a bare origin, the checkout the daemon runs
// from, and a clone that plays the merges), with fake npm, launchd and daemon; and scripts/deploy.ts end to end against a real
// daemon with stand-ins for npm and launchctl only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { NO_RESTART, PushRefused, deployOnce, refusesRequest } from "../src/deploy.ts";
import type { DeployDeps, DeployOutcome, DeployState, Push } from "../src/deploy.ts";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { createHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";
import { agentSocket, asArchitect, author, server, wakeSocket } from "./helpers.ts";
import { fakeSsh } from "./fake-ssh.ts";

const BRANCH = "main";
/** The repository the origin stands for: the job reads it from the last two parts of the remote's address. */
const REPO = "Ming-Research/Whitefoot";
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity }, stdio: ["ignore", "pipe", "pipe"] }).trim();
type After = { after(fn: () => void | Promise<void>): void };

/** A bare origin, the checkout the daemon runs from, and `seed`, the clone a merge is made in and pushed from. */
async function repos(t: After) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-deploy-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const origin = join(dir, `${REPO}.git`), seed = join(dir, "seed"), checkout = join(dir, "checkout");
  sh(dir, "init", "-q", "--bare", "-b", BRANCH, origin);
  sh(dir, "clone", "-q", origin, seed);
  sh(seed, "checkout", "-q", "-B", BRANCH);
  const write = (root: string, files: Record<string, string>) => { for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); } };
  const publish = (message: string) => { sh(seed, "add", "-A"); sh(seed, "commit", "-q", "-m", message); sh(seed, "push", "-q", "origin", BRANCH); return sh(seed, "rev-parse", "HEAD"); };
  /** One merged pull request: these files change on the main line. */
  const land = (files: Record<string, string>, message: string) => { write(seed, files); return publish(message); };
  const first = land({ "src/main.ts": "run", "web/index.html": "page", "docs/design.md": "doc", "test/a.test.ts": "test", "package-lock.json": "lock 1", "README.md": "readme" }, "first");
  sh(dir, "clone", "-q", "-b", BRANCH, origin, checkout);
  return { dir, origin, repo: REPO, seed, checkout, first, land, publish, write, head: () => sh(checkout, "rev-parse", "HEAD"), short: (sha: string) => sh(seed, "rev-parse", "--short", sha) };
}

/** The deploy's outside world: npm, launchd and the daemon are fakes that record what they were asked and read the checkout to
 * decide whether the daemon "starts": a src/main.ts holding BROKEN is a daemon that never answers /health, and one holding CRASH LOOP
 * answers but is replaced by launchd again and again. */
function world(r: Awaited<ReturnType<typeof repos>>, override: Partial<DeployDeps> = {}) {
  const w = {
    builds: [] as Array<{ args: string[]; head: string }>, posts: [] as Push[], notices: [] as string[][], restarts: 0, clock: 0, failBuilds: 0,
    // npm ci fails; the next probes of /health fail; something to do once a build has run.
    failCi: false, flaky: 0, afterBuild: undefined as (() => void) | undefined,
    daemon: { pid: 100 as number | undefined, ok: true, flap: false, takes: true },
    saved: { outbox: [] } as DeployState,
  };
  const git: DeployDeps["git"] = async args => {
    try { return execFileSync("git", args, { cwd: r.checkout, encoding: "utf8", env: { ...process.env, ...identity }, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { throw Object.assign(new Error(String((error as { stderr?: unknown }).stderr)), { code: (error as { status?: number }).status }); }
  };
  const deps: DeployDeps = {
    branch: BRANCH, remote: "origin",
    git,
    // The fetch goes through its own dependency, which scripts/deploy.ts bounds in time (test below); here it is plain git.
    network: git,
    // The head is read when npm runs: a build must come after the checkout has moved, in both directions.
    run: async (command, args) => {
      w.builds.push({ args: [command, ...args], head: r.head() });
      w.afterBuild?.();
      if (w.failCi && args[0] === "ci") throw new Error("npm ci failed");
      if (w.failBuilds > 0) { w.failBuilds--; throw new Error("build failed"); }
    },
    pid: async () => (w.daemon.flap && w.daemon.pid !== undefined ? ++w.daemon.pid : w.daemon.pid),
    restart: async () => {
      const code = readFileSync(join(r.checkout, "src/main.ts"), "utf8");
      w.restarts++; w.daemon.pid = (w.daemon.pid ?? 100) + 1000; w.daemon.ok = !code.includes("BROKEN"); w.daemon.flap = code.includes("CRASH LOOP");
    },
    healthy: async () => { if (w.flaky > 0) { w.flaky--; return false; } return w.daemon.ok && w.daemon.pid !== undefined; },
    post: async push => { if (!w.daemon.takes) throw new Error("the daemon is down"); w.posts.push(push); },
    notify: (title, message) => { w.notices.push([title, message]); },
    load: () => structuredClone(w.saved), save: state => { w.saved = structuredClone(state); },
    sleep: async ms => { w.clock += ms; }, now: () => w.clock, log: () => {},
    waitMs: 90_000, stableMs: 5000, fetchRetryMs: 10_000,
  };
  return { w, deps, deploy: () => deployOnce({ ...deps, ...override }) };
}

const BUILD = ["npm", "run", "-s", "build:web"];

test("with nothing new on the main line the job does nothing and says nothing", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  assert.equal(await deploy(), "current");
  assert.deepEqual({ builds: w.builds, posts: w.posts, restarts: w.restarts }, { builds: [], posts: [], restarts: 0 });
});

test("a merged change is moved to, built, the daemon restarted once it is healthy, and the push names the version and the changes", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "src/ops.ts": "more" }, "Add more (#1)");
  assert.equal(await deploy(), "deployed");
  assert.equal(r.head(), sha);
  assert.deepEqual(w.builds, [{ args: BUILD, head: sha }], "built after the checkout moved");
  assert.equal(w.restarts, 1);
  assert.deepEqual(w.posts, [{ event: "deployed", version: sha, previous: r.first, changes: [`${r.short(sha)} Add more (#1)`], restarted: true, repo: r.repo }]);
  assert.equal(w.saved.healthy, sha);
  assert.deepEqual(w.saved.outbox, []);
  // The next run finds nothing to do.
  assert.equal(await deploy(), "current");
  assert.equal(w.restarts, 1); assert.equal(w.posts.length, 1);
});

test("changes merged between two runs are one deploy: one restart, one push listing both, newest first", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const a = r.land({ "src/a.ts": "a" }, "A (#1)"), b = r.land({ "src/b.ts": "b" }, "B (#2)");
  assert.equal(await deploy(), "deployed");
  assert.equal(w.restarts, 1);
  assert.equal(w.builds.length, 1);
  assert.deepEqual(w.posts, [{ event: "deployed", version: b, previous: r.first, changes: [`${r.short(b)} B (#2)`, `${r.short(a)} A (#1)`], restarted: true, repo: r.repo }]);
});

test("a long list of changes is cut and the rest counted", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  for (let i = 0; i < 23; i++) r.land({ [`docs/n${i}.md`]: String(i) }, `change ${i}`);
  await deploy();
  const changes = w.posts[0]!.changes as unknown[];
  assert.equal(changes.length, 21);
  assert.deepEqual(changes[20], { more: 3 });
});

// The paths that need no restart are listed in NO_RESTART, and nothing else: unlisted paths, even harmless ones, restart.
for (const [name, files, restarts] of [
  ["docs", { "docs/design.md": "new" }, false],
  ["tests", { "test/a.test.ts": "new" }, false],
  ["the page", { "web/index.html": "new", "web/app.ts": "new" }, false],
  ["a mix of listed paths", { "docs/design.md": "new", "test/a.test.ts": "new", "web/index.html": "new" }, false],
  ["the daemon's source", { "src/main.ts": "new" }, true],
  ["the readme", { "README.md": "new" }, false],
  ["the license", { "LICENSE": "new" }, false],
  ["the agent instructions", { "AGENTS.md": "new" }, false],
  ["the workflows", { ".github/workflows/ci.yml": "new" }, false],
  ["the design tree", { "design/log.md": "new", "design/storage.md": "new" }, false],
  ["the submodule list", { ".gitmodules": "new" }, false],
  ["the Makefile", { "Makefile": "new" }, false],
  ["a root docs file not listed", { "CHANGELOG.md": "new" }, true],
  ["a file whose name starts with the readme", { "README.mdx": "new" }, true],
  ["a file whose name starts with the license", { "LICENSE.ts": "new" }, true],
  ["a file whose name starts with the Makefile", { "Makefile.ts": "new" }, true],
  ["a file whose name starts with the design directory's", { "design.ts": "new" }, true],
  ["the job's own script", { "scripts/deploy.ts": "new" }, true],
  ["packages", { "package.json": "{}" }, true],
  ["one source file among docs", { "docs/design.md": "new", "src/main.ts": "new" }, true],
] as const) {
  test(`a change to ${name} ${restarts ? "restarts" : "does not restart"} the daemon`, async t => {
    const r = await repos(t), { w, deploy } = world(r);
    const sha = r.land({ ...files }, "change");
    assert.equal(await deploy(), "deployed");
    assert.equal(w.restarts, restarts ? 1 : 0);
    assert.deepEqual(w.posts.map(p => [p.event, p.restarted]), [["deployed", restarts]]);
    assert.deepEqual(w.builds, [{ args: BUILD, head: sha }], "the page is built either way");
  });
}

test("moving a source file into a listed directory still restarts: the file it left changed", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  r.land({ "src/moved.ts": "x" }, "add");
  await deploy();
  assert.equal(w.restarts, 1);
  sh(r.seed, "mv", "src/moved.ts", "docs/moved.ts");
  r.publish("move");
  assert.equal(await deploy(), "deployed");
  assert.equal(w.restarts, 2);
});

test("a changed lock file installs the packages before the build, and an unchanged one does not", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "package-lock.json": "lock 2", "src/a.ts": "a" }, "new dependency");
  await deploy();
  assert.deepEqual(w.builds, [{ args: ["npm", "ci"], head: sha }, { args: BUILD, head: sha }]);
  w.builds.length = 0;
  const next = r.land({ "src/a.ts": "b" }, "no new dependency");
  await deploy();
  assert.deepEqual(w.builds, [{ args: BUILD, head: next }]);
});

test("a daemon that does not come up is rolled back: the code and the page go back, it restarts on them, and the failure is pushed", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const bad = r.land({ "src/main.ts": "BROKEN" }, "Break the daemon (#2)");
  assert.equal(await deploy(), "rolledBack");
  assert.equal(r.head(), r.first, "the checkout is on the commit that was serving");
  assert.deepEqual(w.builds, [{ args: BUILD, head: bad }, { args: BUILD, head: r.first }], "the page is built again from the old code");
  assert.equal(w.restarts, 2);
  assert.equal(w.daemon.ok, true, "the daemon serves again");
  assert.ok(w.clock >= 90_000, "it waited out the limit before giving up");
  assert.deepEqual(w.posts, [{ event: "deployFailed", version: bad, running: r.first, reason: w.posts[0]!.reason, changes: [`${r.short(bad)} Break the daemon (#2)`], repo: r.repo }]);
  assert.match(String(w.posts[0]!.reason), /not healthy/);
  assert.deepEqual([w.saved.failed, w.saved.healthy, w.saved.pending], [bad, r.first, undefined], "the rollback is finished, so nothing is pending");
  assert.equal(w.notices.length, 0, "the owner is told only when the board cannot be brought back");

  // The failed commit is not tried again, and nothing more is pushed, while the remote has nothing newer.
  const restarts = w.restarts;
  assert.equal(await deploy(), "skipped");
  assert.equal(w.restarts, restarts); assert.equal(w.posts.length, 1);
  // A newer commit is tried; the fix goes through, and the failure is forgotten.
  const fix = r.land({ "src/main.ts": "fixed" }, "Fix the daemon (#3)");
  assert.equal(await deploy(), "deployed");
  assert.equal(r.head(), fix);
  assert.equal(w.saved.failed, undefined);
  assert.deepEqual(w.posts.map(p => p.event), ["deployFailed", "deployed"]);
});

test("a daemon that restarts but keeps being replaced is not healthy: the process must stay the same", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  r.land({ "src/main.ts": "CRASH LOOP" }, "Crash loop");
  assert.equal(await deploy(), "rolledBack");
  assert.equal(r.head(), r.first);
});

test("a failed build rolls back too, without a restart of its own for a change that needed none", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  r.land({ "web/index.html": "broken page" }, "Break the page");
  w.failBuilds = 1;
  assert.equal(await deploy(), "rolledBack");
  assert.equal(r.head(), r.first);
  assert.equal(w.restarts, 0);
  assert.equal(w.builds.length, 2);
  assert.equal(w.builds[1]!.head, r.first);
  assert.equal(w.posts[0]!.event, "deployFailed");
});

test("when going back fails too the owner is told on the Mac, and the push says nothing is running", async t => {
  const r = await repos(t);
  // A daemon that never starts, whatever the checkout holds.
  const { w, deploy } = world(r, { restart: async () => { w.restarts++; w.daemon.pid = (w.daemon.pid ?? 100) + 1000; w.daemon.ok = false; } });
  const bad = r.land({ "src/main.ts": "BROKEN" }, "Break the daemon");
  assert.equal(await deploy(), "down");
  assert.equal(r.head(), r.first, "the code went back though the daemon did not come up");
  assert.equal(w.restarts, 2);
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0]![0], "看板起不来");
  assert.match(w.notices[0]![1]!, new RegExp(`${bad.slice(0, 7)}.*${r.first.slice(0, 7)}`));
  assert.deepEqual(w.posts.map(p => [p.event, p.version, p.running]), [["deployFailed", bad, null]]);
  assert.deepEqual([w.saved.failed, w.saved.healthy], [bad, r.first], "the commit the daemon was serving when the run began is the last healthy one");
  // The rollback is unfinished, so the next run tries it again, and does not alarm anyone twice with the same news.
  assert.deepEqual(w.saved.pending, { target: bad, to: r.first, restarted: true, heads: [r.first] });
  assert.equal(await deploy(), "down");
  assert.equal(w.restarts, 3);
  assert.equal(w.notices.length, 1); assert.equal(w.posts.length, 1);
});

test("a failed notification does not stop the job", async t => {
  const r = await repos(t);
  const { w, deploy } = world(r, { restart: async () => { w.daemon.pid = (w.daemon.pid ?? 100) + 1000; w.daemon.ok = false; }, notify: () => { throw new Error("no osascript"); } });
  r.land({ "src/main.ts": "BROKEN" }, "Break the daemon");
  assert.equal(await deploy(), "down");
  assert.equal(w.posts.length, 1);
});

test("a failed deploy while the board was already down goes back to the last commit known healthy, not to where the checkout was", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  // Someone fast-forwarded the checkout by hand to `middle`; the board then went down on it. The job's own record says `first` served.
  const middle = r.land({ "src/a.ts": "a" }, "middle");
  sh(r.checkout, "fetch", "-q", "origin");
  sh(r.checkout, "merge", "-q", "--ff-only", middle);
  w.saved.healthy = r.first; w.daemon.ok = false;
  const bad = r.land({ "src/main.ts": "BROKEN" }, "Break the daemon");
  assert.equal(await deploy(), "rolledBack");
  assert.equal(r.head(), r.first);
  assert.deepEqual(w.posts.map(p => [p.event, p.version, p.running]), [["deployFailed", bad, r.first]]);
});

test("a change that needs no restart still restarts a daemon that is down, since a deploy must leave the board up", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  w.daemon.ok = false;
  r.land({ "docs/design.md": "new" }, "docs only");
  assert.equal(await deploy(), "deployed");
  assert.equal(w.restarts, 1);
  assert.equal(w.daemon.ok, true);
});

test("a checkout with local changes to tracked files is not moved, and one push says why, once", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  writeFileSync(join(r.checkout, "README.md"), "someone's edit");
  const sha = r.land({ "src/a.ts": "a" }, "A");
  assert.equal(await deploy(), "refused");
  assert.equal(r.head(), r.first);
  assert.equal(readFileSync(join(r.checkout, "README.md"), "utf8"), "someone's edit", "the edit is untouched");
  assert.equal(w.restarts, 0); assert.equal(w.builds.length, 0);
  assert.deepEqual(w.posts.map(p => [p.event, p.version, p.running]), [["deployFailed", sha, r.first]]);
  assert.match(String(w.posts[0]!.reason), /local changes.*README\.md/);
  // Five minutes later, the same reason for the same commit: no second push.
  assert.equal(await deploy(), "refused");
  assert.equal(w.posts.length, 1);
  // A newer commit is a new thing to say.
  const newer = r.land({ "src/b.ts": "b" }, "B");
  assert.equal(await deploy(), "refused");
  assert.equal(w.posts.length, 2);
  assert.equal(w.posts[1]!.version, newer);
  // Once the edit is gone the job catches up in one deploy.
  sh(r.checkout, "checkout", "-q", "--", "README.md");
  assert.equal(await deploy(), "deployed");
  assert.equal(r.head(), newer);
  assert.equal(w.posts.at(-1)!.event, "deployed");
});

test("an untracked file in the checkout does not stop a deploy", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  writeFileSync(join(r.checkout, ".DS_Store"), "junk");
  r.land({ "src/a.ts": "a" }, "A");
  assert.equal(await deploy(), "deployed");
  assert.equal(w.restarts, 1);
});

test("a checkout with a commit the main line lacks, or on another branch, is not moved", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  writeFileSync(join(r.checkout, "local.txt"), "mine");
  sh(r.checkout, "add", "local.txt"); sh(r.checkout, "commit", "-q", "-m", "local work");
  const local = r.head();
  const sha = r.land({ "src/a.ts": "a" }, "A");
  assert.equal(await deploy(), "refused");
  assert.equal(r.head(), local, "the local commit is kept");
  assert.match(String(w.posts[0]!.reason), /not an ancestor/);
  assert.equal(w.posts[0]!.version, sha);
  sh(r.checkout, "checkout", "-q", "-b", "other");
  assert.equal(await deploy(), "refused");
  assert.match(String(w.posts[1]!.reason), /on other, not main/);
  assert.equal(w.restarts, 0);
});

test("a push the daemon does not take is kept and sent first on the next run", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  w.daemon.takes = false;
  const sha = r.land({ "docs/design.md": "new" }, "docs");
  assert.equal(await deploy(), "deployed");
  assert.equal(w.posts.length, 0);
  assert.equal(w.saved.outbox.length, 1, "kept in the state file");
  assert.equal(await deploy(), "current");
  assert.equal(w.saved.outbox.length, 1, "still kept while the daemon does not take it");
  w.daemon.takes = true;
  assert.equal(await deploy(), "current");
  assert.deepEqual(w.posts.map(p => [p.event, p.version]), [["deployed", sha]]);
  assert.deepEqual(w.saved.outbox, []);
});

test("only a 4xx other than a request for time says the request is wrong", () => {
  for (const status of [400, 403, 404, 413, 422, 499]) assert.equal(refusesRequest(status), true, String(status));
  for (const status of [200, 204, 301, 408, 429, 500, 502, 503]) assert.equal(refusesRequest(status), false, String(status));
});

test("a push the daemon refuses is dropped and the pushes behind it are sent; one it could not take stays", async t => {
  const r = await repos(t), { w, deploy } = world(r, {
    // The daemon's rule for the request: the older job's shape, without the repository, is turned down.
    post: async push => { if (!w.daemon.takes) throw new Error("the daemon is down"); if (!("repo" in push)) throw new PushRefused("POST /api/wake answered 400: asks for the fields"); w.posts.push(push); },
  });
  // What a job of the older version left in the outbox when the daemon restarted on this version.
  w.saved.outbox.push({ event: "deployed", version: "a".repeat(40), previous: "b".repeat(40), changes: [], restarted: true });
  w.daemon.takes = false;
  const sha = r.land({ "docs/design.md": "new" }, "docs");
  assert.equal(await deploy(), "deployed");
  assert.equal(w.saved.outbox.length, 2, "while the daemon is down both stay");
  w.daemon.takes = true;
  assert.equal(await deploy(), "current");
  assert.deepEqual(w.posts.map(p => [p.event, p.version]), [["deployed", sha]], "the refused one is gone and the one behind it was sent");
  assert.deepEqual(w.saved.outbox, []);
});

test("an unreachable remote is tried again within the run, then pushed once, and pushed again if it happens again after a good run", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  sh(r.checkout, "remote", "set-url", "origin", join(r.dir, "nowhere.git"));
  assert.equal(await deploy(), "unreachable");
  assert.ok(w.clock >= 20_000, "it waited between its three tries");
  assert.deepEqual(w.posts.map(p => [p.event, p.version, p.running]), [["deployFailed", null, r.first]]);
  assert.match(String(w.posts[0]!.reason), /could not fetch origin\/main/);
  assert.deepEqual({ restarts: w.restarts, builds: w.builds.length }, { restarts: 0, builds: 0 });
  assert.equal(await deploy(), "unreachable");
  assert.equal(w.posts.length, 1, "the same news is not pushed again");
  sh(r.checkout, "remote", "set-url", "origin", r.origin);
  assert.equal(await deploy(), "current");
  sh(r.checkout, "remote", "set-url", "origin", join(r.dir, "nowhere.git"));
  assert.equal(await deploy(), "unreachable");
  assert.equal(w.posts.length, 2, "a problem that comes back is news again");
});

test("a fetch that fails once and then works is no news", async t => {
  const r = await repos(t), { w, deps } = world(r);
  let failures = 1;
  const sha = r.land({ "src/a.ts": "a" }, "A");
  const outcome = await deployOnce({ ...deps, network: async args => { if (failures-- > 0) throw new Error("Could not resolve host"); return deps.network(args); } });
  assert.equal(outcome, "deployed");
  assert.deepEqual(w.posts.map(p => [p.event, p.version]), [["deployed", sha]]);
});

test("a failure of the job itself is pushed once, and the job goes on trying", async t => {
  const r = await repos(t), { w, deps } = world(r);
  let broken = true;
  const run = () => deployOnce({ ...deps, git: async args => { if (broken && args[0] === "status") throw new Error("boom"); return deps.git(args); } });
  const sha = r.land({ "src/a.ts": "a" }, "A");
  assert.equal(await run(), "error");
  assert.deepEqual(w.posts.map(p => [p.event, p.version, p.running]), [["deployFailed", null, null]]);
  assert.match(String(w.posts[0]!.reason), /boom/);
  assert.equal(await run(), "error");
  assert.equal(w.posts.length, 1);
  broken = false;
  assert.equal(await run(), "deployed");
  assert.equal(r.head(), sha);
});

test("a health probe that misses does not fail a deploy that needed no restart", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  r.land({ "docs/design.md": "new" }, "docs");
  // The daemon is busy for the first three probes after the build.
  w.afterBuild = () => { w.flaky = 3; };
  assert.equal(await deploy(), "deployed");
  assert.deepEqual(w.posts.map(p => [p.event, p.restarted]), [["deployed", false]]);
  assert.equal(w.restarts, 0);
});

test("a daemon that answers when the job starts is the last healthy commit, however the checkout got there", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  // The job once recorded `first`; two hand deploys since moved the checkout and the daemon to `middle`.
  const middle = r.land({ "src/a.ts": "a" }, "middle");
  sh(r.checkout, "fetch", "-q", "origin");
  sh(r.checkout, "merge", "-q", "--ff-only", middle);
  w.saved.healthy = r.first;
  // The first probe at the start of the run misses.
  w.flaky = 1;
  r.land({ "src/main.ts": "BROKEN" }, "Break the daemon");
  assert.equal(await deploy(), "rolledBack");
  assert.equal(r.head(), middle, "back on what was serving, not on what the job last saw");
  assert.equal(w.saved.healthy, middle);
});

test("the commit the daemon is serving is remembered by a run that deploys nothing, for a later failure while the daemon is down", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  // Two hand deploys moved the checkout and the daemon to `middle`; the job's record still says `first`.
  const middle = r.land({ "src/a.ts": "a" }, "middle");
  sh(r.checkout, "fetch", "-q", "origin");
  sh(r.checkout, "merge", "-q", "--ff-only", middle);
  w.saved.healthy = r.first;
  assert.equal(await deploy(), "current");
  assert.equal(w.saved.healthy, middle);
  // The daemon then goes down, and the next deploy is bad too.
  w.daemon.ok = false;
  r.land({ "src/main.ts": "BROKEN" }, "Break the daemon");
  assert.equal(await deploy(), "rolledBack");
  assert.equal(r.head(), middle, "it went back to the commit last seen serving, not to the older one in the record");
});

test("when going back fails but the daemon still answers, the owner is not alarmed and the next run finishes the rollback", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "package-lock.json": "lock 2", "src/a.ts": "a" }, "new dependency");
  // npm cannot reach its registry: the install fails going forward and going back, and leaves node_modules in pieces.
  w.failCi = true;
  assert.equal(await deploy(), "stuck");
  assert.equal(r.head(), r.first, "the code is back, the packages are not");
  assert.equal(w.restarts, 0, "the daemon it never restarted still serves");
  assert.equal(w.notices.length, 0);
  assert.deepEqual(w.posts.map(p => [p.event, p.version, p.running]), [["deployFailed", sha, null]]);
  assert.match(String(w.posts[0]!.reason), /still answers.*tries again/);
  assert.deepEqual(w.saved.pending, { target: sha, to: r.first, restarted: false, heads: [r.first] });
  // It is not skipped as a failed commit: it is retried, and the same news is not pushed again.
  assert.equal(await deploy(), "stuck");
  assert.equal(w.posts.length, 1);
  // Once npm works the rollback is finished: packages installed whatever the lock file says, page built, no restart.
  w.failCi = false; w.builds.length = 0;
  assert.equal(await deploy(), "rolledBack");
  assert.deepEqual(w.builds, [{ args: ["npm", "ci"], head: r.first }, { args: BUILD, head: r.first }]);
  assert.equal(w.restarts, 0);
  assert.equal(w.saved.pending, undefined);
  assert.equal(w.saved.healthy, r.first);
  assert.deepEqual(w.posts.map(p => [p.event, p.running]), [["deployFailed", null], ["deployFailed", r.first]]);
  // The failed commit then waits for a newer one.
  assert.equal(await deploy(), "skipped");
});

test("a merge that git refuses, as with a stale index.lock, says nothing about the commit: it is recovered from, then deployed", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "src/a.ts": "a" }, "A");
  const lock = join(r.checkout, ".git/index.lock");
  writeFileSync(lock, "");
  assert.equal(await deploy(), "stuck");
  assert.match(String(w.posts[0]!.reason), /index\.lock/);
  assert.equal(w.saved.failed, undefined, "the commit never reached the checkout, so it is not marked failed");
  rmSync(lock);
  assert.equal(await deploy(), "rolledBack", "the unfinished deploy is finished first");
  assert.equal(r.head(), r.first);
  assert.equal(await deploy(), "deployed", "and the commit gets its turn");
  assert.equal(r.head(), sha);
  assert.deepEqual(w.posts.map(p => p.event), ["deployFailed", "deployFailed", "deployed"]);
});

test("a deploy interrupted part way is finished first on the next run, then the commit is tried again", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "src/a.ts": "a" }, "A");
  // The job died after it moved the checkout and before it restarted the daemon.
  sh(r.checkout, "fetch", "-q", "origin");
  sh(r.checkout, "merge", "-q", "--ff-only", sha);
  w.saved.pending = { target: sha, to: r.first, restarted: false, heads: [sha] };
  assert.equal(await deploy(), "rolledBack");
  assert.equal(r.head(), r.first);
  assert.deepEqual(w.builds, [{ args: ["npm", "ci"], head: r.first }, { args: BUILD, head: r.first }]);
  assert.equal(w.restarts, 0, "the daemon never ran the new code");
  assert.match(String(w.posts[0]!.reason), /interrupted/);
  assert.equal(await deploy(), "deployed");
  assert.equal(r.head(), sha);
});

test("an interrupted deploy that had begun the restart restarts the daemon again on the old code", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "src/a.ts": "a" }, "A");
  sh(r.checkout, "fetch", "-q", "origin");
  sh(r.checkout, "merge", "-q", "--ff-only", sha);
  w.saved.pending = { target: sha, to: r.first, restarted: true, heads: [sha] };
  assert.equal(await deploy(), "rolledBack");
  assert.equal(w.restarts, 1);
});

type Repos = Awaited<ReturnType<typeof repos>>;
/** A deploy that did not end: git refuses its merge (a stale index.lock), going back is refused too, and the daemon still answers.
 * The checkout is on `first` with the lock gone and a pending record in the state; returns the commit that was being deployed. */
async function leftUnfinished(r: Repos, deploy: () => Promise<DeployOutcome>) {
  const sha = r.land({ "src/a.ts": "a" }, "A");
  const lock = join(r.checkout, ".git/index.lock");
  writeFileSync(lock, "");
  assert.equal(await deploy(), "stuck");
  rmSync(lock);
  return sha;
}

test("a checkout moved by hand while a rollback was unfinished is taken over as it is: nothing is reset, one push says so", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  await leftUnfinished(r, deploy);
  // The architect deploys by hand, to a newer commit.
  const hand = r.land({ "src/b.ts": "b" }, "B");
  sh(r.checkout, "fetch", "-q", "origin");
  sh(r.checkout, "merge", "-q", "--ff-only", hand);
  w.builds.length = 0;
  assert.equal(await deploy(), "current");
  assert.equal(r.head(), hand, "the hand deploy stays");
  assert.deepEqual({ builds: w.builds.length, restarts: w.restarts, notices: w.notices.length }, { builds: 0, restarts: 0, notices: 0 });
  assert.deepEqual([w.saved.pending, w.saved.healthy], [undefined, hand], "the record is dropped, and the commit that serves is the last healthy one");
  assert.equal(w.posts.length, 2);
  assert.match(String(w.posts[1]!.reason), /changed by hand.*took over.*reset nothing/);
});

test("a hand-made checkout the daemon does not answer on is the one failure the job answers: the owner is told on the Mac", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  await leftUnfinished(r, deploy);
  const hand = r.land({ "src/b.ts": "b" }, "B");
  sh(r.checkout, "fetch", "-q", "origin");
  sh(r.checkout, "merge", "-q", "--ff-only", hand);
  w.daemon.ok = false;
  assert.equal(await deploy(), "current");
  assert.equal(r.head(), hand, "still not reset");
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0]![0], "看板起不来");
  assert.equal(w.restarts, 0);
});

test("a hand fix that lands exactly on the deploy's target is not undone: where the job left the checkout is what counts", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "package-lock.json": "lock 2", "src/a.ts": "a" }, "new dependency");
  // npm cannot reach its registry: the job merged, failed, went back to `first`, and could not reinstall.
  w.failCi = true;
  assert.equal(await deploy(), "stuck");
  assert.equal(r.head(), r.first);
  // The registry is back and the architect fixes it by hand: the same commit, deployed, built and serving.
  w.failCi = false;
  sh(r.checkout, "merge", "-q", "--ff-only", sha);
  w.builds.length = 0;
  assert.equal(await deploy(), "current");
  assert.equal(r.head(), sha, "the hand fix stays, though it is the commit the job had gone back from");
  assert.deepEqual({ builds: w.builds.length, restarts: w.restarts, notices: w.notices.length }, { builds: 0, restarts: 0, notices: 0 });
  assert.match(String(w.posts.at(-1)!.reason), /changed by hand/);
  assert.equal(w.saved.pending, undefined);
});

test("a checkout the job left where a hand deploy had put it is the job's own: a refused merge does not make it 'changed by hand'", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  // A hand deploy to C left the daemon down; the job's record of the last healthy commit is older.
  const c = r.land({ "src/a.ts": "a" }, "C");
  sh(r.checkout, "fetch", "-q", "origin");
  sh(r.checkout, "merge", "-q", "--ff-only", c);
  w.saved.healthy = r.first; w.daemon.ok = false;
  r.land({ "src/b.ts": "b" }, "M");
  const lock = join(r.checkout, ".git/index.lock");
  writeFileSync(lock, "");
  assert.equal(await deploy(), "down");
  assert.equal(w.notices.length, 1);
  rmSync(lock);
  // The unfinished deploy is finished, going back to the last healthy commit as a daemon that does not answer calls for.
  assert.equal(await deploy(), "rolledBack");
  assert.equal(r.head(), r.first);
  assert.doesNotMatch(w.posts.map(p => String(p.reason)).join("\n"), /changed by hand/);
  assert.equal(w.notices.length, 1, "the owner was not alarmed a second time with a wrong story");
});

for (const { name, touch, why } of [
  { name: "a branch made to look into something", touch: (r: Repos) => { sh(r.checkout, "checkout", "-q", "-b", "debug"); }, why: /on debug, not main/ },
  { name: "a local edit", touch: (r: Repos) => { writeFileSync(join(r.checkout, "README.md"), "edit"); }, why: /local changes to tracked files/ },
]) {
  test(`${name} in the checkout while a rollback was unfinished is not reset: the record is dropped and the checkout is refused as any such one is`, async t => {
    const r = await repos(t), { w, deploy } = world(r);
    const sha = await leftUnfinished(r, deploy);
    touch(r);
    assert.equal(await deploy(), "refused");
    assert.equal(r.head(), r.first);
    assert.deepEqual({ builds: w.builds.length, restarts: w.restarts }, { builds: 0, restarts: 0 }, "the rollback was not retried: no reinstall, no build");
    assert.equal(w.saved.pending, undefined);
    assert.deepEqual(w.posts.map(p => [p.event, p.version]), [["deployFailed", sha], ["deployFailed", sha], ["deployFailed", sha]]);
    assert.match(String(w.posts[1]!.reason), /changed by hand/);
    assert.match(String(w.posts[2]!.reason), why);
    if (name.startsWith("a branch")) assert.equal(sh(r.checkout, "symbolic-ref", "--short", "HEAD"), "debug", "the branch is where its owner left it");
    if (name === "a local edit") assert.equal(readFileSync(join(r.checkout, "README.md"), "utf8"), "edit");
  });
}

test("two standing problems that come and go in turn are each pushed once", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  writeFileSync(join(r.checkout, "README.md"), "edit");
  r.land({ "src/a.ts": "a" }, "A");
  const away = join(r.dir, "nowhere.git");
  for (let round = 0; round < 3; round++) {
    assert.equal(await deploy(), "refused");
    sh(r.checkout, "remote", "set-url", "origin", away);
    assert.equal(await deploy(), "unreachable");
    sh(r.checkout, "remote", "set-url", "origin", r.origin);
  }
  assert.deepEqual(w.posts.map(p => String(p.reason).slice(0, 12)), ["the checkout", "could not fe"]);
});

test("the daemon reads nothing of the checkout at runtime but the page files, so the paths that need no restart stay valid", async () => {
  const src = join(import.meta.dirname, "../src");
  // Every module the daemon loads, from its entry point on.
  const loaded = new Set<string>(), queue = ["main.ts"];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (loaded.has(file)) continue;
    loaded.add(file);
    for (const [, next] of (await readFile(join(src, file), "utf8")).matchAll(/from "\.\/([\w-]+\.ts)"/g)) queue.push(next!);
  }
  const readers: string[] = [];
  for (const file of [...loaded].sort()) if (/\b(readFile|readFileSync|createReadStream|readdir|readdirSync|openSync)\b/.test(await readFile(join(src, file), "utf8"))) readers.push(file);
  // http.ts reads the page files, store.ts the board's data directory, wake.ts, liveness.ts, watch.ts and usage-watch.ts their state files
  // (kept in that directory), credentials.ts the credentials file (kept outside the checkout and the data directory). A module that reads the checkout itself, such as docs/ or a template, would make a change there need a
  // restart: NO_RESTART (src/deploy.ts) must change first.
  assert.deepEqual(readers, ["credentials.ts", "http.ts", "liveness.ts", "store.ts", "usage-watch.ts", "wake.ts", "watch.ts"]);
  const http = await readFile(join(src, "http.ts"), "utf8");
  // The one read of a file in http.ts is pageFile, and it is asked for the page files only: the page, its bundle and the diagram library.
  assert.deepEqual([...http.matchAll(/readFile\(([^)]*\))\)?/g)].map(m => m[1]), ["join(deps.webDir, name)"]);
  const asked = [...http.matchAll(/\b(?:optionalPageFile|pageFile)\("([^"]*)"\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(asked)].sort(), ["dist/app.js", "dist/mermaid.js", "index.html"]);
  // Every other mention is a definition: pageFile's own, optionalPageFile's, and the pageFile call inside optionalPageFile. A call with a name
  // that is not a literal, or either passed on, would read a file this test cannot see.
  assert.equal([...http.matchAll(/\b(?:optionalPageFile|pageFile)\b/g)].length, asked.length + 3);
  assert.ok(NO_RESTART.includes("web/"));
});

test("the page files are read from disk on each request, so a rebuilt page needs no restart", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-web-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "dist"));
  const store = await Store.open(join(dir, "data"), { init: true, board: { title: "Synthetic board", projects: [{ name: "Whitefoot" }] } });
  const op = ops(store);
  const http = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: dir, createMcp: () => createMcpServer({ store, ops: op }) });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const [route, file] of [["/", "index.html"], ["/app.js", "dist/app.js"], ["/mermaid.js", "dist/mermaid.js"]] as const) {
    for (const version of ["one", "two"]) {
      writeFileSync(join(dir, file), version);
      assert.equal(await (await fetch(url + route)).text(), version, `${route} after ${file} became ${version}`);
    }
  }
});

test("scripts/deploy.ts end to end: real git, the health check, launchd's pid and the pushes through the daemon's own route", async t => {
  const r = await repos(t);
  const { url, port, store, op } = await server(t);
  // The deploys are told to the engineer holding the item whose 改动 section names the pull requests the commits carry.
  const a = store.snapshot().items.a!;
  await store.commit({ author, message: "name the pull requests", puts: [{ kind: "item", id: "a", expectRev: a.rev, doc: { ...a, head: `${a.head}\n\n**改动**\n\n${REPO}#1 ${REPO}#2 ${REPO}#3` } }] });
  await op.dispatchStart({ ...asArchitect, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "a-worker", agentId: "agent-a" });
  const star = await agentSocket(t, url, "a-worker");
  const bin = join(r.dir, "bin"), calls = join(r.dir, "calls.log"), pidFile = join(r.dir, "pid"), stateFile = join(r.dir, "state/deploy.json");
  mkdirSync(bin); writeFileSync(pidFile, "100"); writeFileSync(calls, "");
  // A state file that does not parse must not stop every run: the job sets it aside and starts empty.
  mkdirSync(dirname(stateFile)); writeFileSync(stateFile, "{not json");
  // launchctl list prints a property list with "PID" = n; and kickstart -k starts a new process: the format is the Mac's own.
  await writeFile(join(bin, "launchctl"), `#!/bin/sh
echo "launchctl $*" >> "$STUB_CALLS"
case "$1" in
  list) printf '{\n\t"Label" = "%s";\n\t"PID" = %s;\n};\n' "$2" "$(cat "$STUB_PID")" ;;
  kickstart) echo $(( $(cat "$STUB_PID") + 1 )) > "$STUB_PID" ;;
esac
`);
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> "$STUB_CALLS"\n`);
  await chmod(join(bin, "launchctl"), 0o755); await chmod(join(bin, "npm"), 0o755);
  const run = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, "../scripts/deploy.ts")], { env: {
      ...process.env, ...identity, PATH: `${bin}:${process.env.PATH}`, STUB_CALLS: calls, STUB_PID: pidFile,
      WF_BOARD_REPO: r.checkout, WF_BOARD_PORT: String(port), WF_BOARD_LABEL: "test.label", WF_BOARD_DEPLOY_STATE: stateFile,
      WF_BOARD_DEPLOY_WAIT_MS: "20000", WF_BOARD_DEPLOY_STABLE_MS: "0",
    } });
    await star.sync();
    return stdout.trim().split("\n").at(-1)!.replace(/^\S+ /, "");
  };
  const calledLines = async () => (await readFile(calls, "utf8")).split("\n").filter(l => l && !l.startsWith("launchctl list"));
  const frames = () => star.events().map(({ at, line, ...frame }) => frame);

  assert.equal(await run(), "current");
  assert.deepEqual(await calledLines(), []);
  assert.equal(readFileSync(`${stateFile}.corrupt`, "utf8"), "{not json");

  // An older job left a request in the shape the daemon no longer takes: the daemon answers 400, and it must not hold the pushes behind it.
  const stale = JSON.parse(await readFile(stateFile, "utf8"));
  stale.outbox = [{ event: "deployed", version: "a".repeat(40), previous: "b".repeat(40), changes: [], restarted: true }];
  await writeFile(stateFile, JSON.stringify(stale));
  assert.equal(await run(), "current");
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).outbox, [], "the refused request was dropped");
  assert.deepEqual(frames(), [], "and nothing was pushed for it");

  const sha = r.land({ "src/a.ts": "a" }, "Add a (#1)");
  assert.equal(await run(), "deployed");
  assert.equal(r.head(), sha);
  assert.deepEqual(await calledLines(), ["npm run -s build:web", `launchctl kickstart -k gui/${process.getuid!()}/test.label`]);
  const delivered = { item: "a", project: "Whitefoot", title: "中文检查" };
  assert.deepEqual(frames(), [{ n: 1, event: "deployed", version: sha, restarted: true, ...delivered, pr: 1 }]);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).healthy, sha);

  // A page-only change builds and pushes without a restart.
  const page = r.land({ "web/index.html": "new page" }, "New page (#2)");
  assert.equal(await run(), "deployed");
  assert.deepEqual((await calledLines()).slice(2), ["npm run -s build:web"]);
  assert.deepEqual(frames().at(-1), { n: 2, event: "deployed", version: page, restarted: false, ...delivered, pr: 2 });

  // A checkout with someone's edit is left alone, and the refusal reaches the architect through the same route.
  writeFileSync(join(r.checkout, "README.md"), "edit");
  const blocked = r.land({ "src/b.ts": "b" }, "Add b (#3)");
  assert.equal(await run(), "refused");
  assert.equal(r.head(), page);
  assert.equal(frames().at(-1)!.event, "deployFailed");
  assert.deepEqual({ ...frames().at(-1), reason: undefined }, { n: 3, event: "deployFailed", version: blocked, running: page, reason: undefined, ...delivered, pr: 3 });
  assert.equal(await run(), "refused");
  assert.equal(star.events().length, 3, "the same refusal is not pushed again");
});

test("scripts/deploy.ts: a fetch that never answers is killed at its cap with its ssh, tried three times, and the remote counts as unreachable", async t => {
  const r = await repos(t);
  const { url, port } = await server(t);
  const star = await wakeSocket(t, url);
  const ssh = await fakeSsh(t);
  await ssh.set("stall");
  sh(r.checkout, "remote", "set-url", "origin", ssh.url(r.origin));
  // Without the cap the job waits for the fetch for good, and launchd never starts a second run: the timeout here turns that into a failure of the test.
  const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, "../scripts/deploy.ts")], { timeout: 60_000, env: {
    ...process.env, ...identity, ...ssh.env, WF_BOARD_REPO: r.checkout, WF_BOARD_PORT: String(port), WF_BOARD_LABEL: "test.label",
    WF_BOARD_DEPLOY_STATE: join(r.dir, "state/deploy.json"), WF_BOARD_DEPLOY_WAIT_MS: "20000", WF_BOARD_DEPLOY_STABLE_MS: "0",
    WF_BOARD_DEPLOY_NET_CAP_MS: "1000", WF_BOARD_DEPLOY_FETCH_RETRY_MS: "0",
  } });
  await star.sync();
  assert.equal(stdout.trim().split("\n").at(-1)!.replace(/^\S+ /, ""), "unreachable");
  assert.equal(await ssh.connections(), 3, "one connection for each try");
  await ssh.gone();
  const [frame] = star.events();
  assert.equal(frame!.event, "deployFailed");
  assert.match(String(frame!.reason), /could not fetch origin\/main: .*killed by the cap after 1 s/);
});
