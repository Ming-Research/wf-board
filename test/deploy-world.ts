// What the deploy job's test files share (test/deploy.test.ts, deploy-recover.test.ts, deploy-script.test.ts, deploy-service.test.ts):
// real git repositories (a bare origin, the checkout the daemon runs from, and a clone that plays the merges), the fake npm, launchd and
// daemon around src/deploy.ts, a stand-in for `gh`, and the checks GitHub may report.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deployOnce } from "../src/deploy.ts";
import type { DeployDeps, DeployOutcome, DeployState, Push } from "../src/deploy.ts";
import type { Checks } from "../src/github.ts";

export const BRANCH = "main";
/** The repository the origin stands for: the job reads it from the last two parts of the remote's address. */
export const REPO = "Ming-Research/Whitefoot";
export const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
export const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity }, stdio: ["ignore", "pipe", "pipe"] }).trim();
export type After = { after(fn: () => void | Promise<void>): void };

export const HOME = "/Users/me";
/** The daemon's service file as the repository holds it (ops/wf-board.plist): `args` are the arguments between the node and the script. */
export const template = (args: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>org.ming-research.wf-board</string>
  <key>ProgramArguments</key><array><string>{{NODE}}</string>${args}<string>{{REPO}}/src/main.ts</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{{PATH}}</string><key>WF_BOARD_DATA</key><string>{{DATA}}</string></dict>
  <key>WorkingDirectory</key><string>{{REPO}}</string>
  <key>StandardOutPath</key><string>{{HOME}}/Library/Logs/wf-board.log</string>
</dict></plist>
`;
/** The installed file for that template: the values an installer chose, written out by hand (the PATH has an & and the data directory a
 * < and a >, which an XML file spells out), the home being the job's own. */
export const installedFor = (args: string, home = HOME) => template(args)
  .replaceAll("{{NODE}}", "/opt/homebrew/opt/node@24/bin/node").replaceAll("{{REPO}}", "/Users/me/dev/wf-board")
  .replaceAll("{{PATH}}", "/opt/homebrew/bin:/usr/bin:/a&amp;b").replaceAll("{{DATA}}", "/Users/me/data &lt;1&gt;").replaceAll("{{HOME}}", home);
export const FLAGS = "<string>--max-semi-space-size=4</string>";

/** A bare origin, the checkout the daemon runs from, and `seed`, the clone a merge is made in and pushed from. */
export async function repos(t: After) {
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
  const first = land({ "src/main.ts": "run", "web/index.html": "page", "docs/design.md": "doc", "test/a.test.ts": "test", "package-lock.json": "lock 1", "README.md": "readme", "ops/wf-board.plist": template("") }, "first");
  sh(dir, "clone", "-q", "-b", BRANCH, origin, checkout);
  return { dir, origin, repo: REPO, seed, checkout, first, land, publish, write, head: () => sh(checkout, "rev-parse", "HEAD"), short: (sha: string) => sh(seed, "rev-parse", "--short", sha) };
}

/** The deploy's outside world: npm, launchd and the daemon are fakes that record what they were asked and read the checkout to
 * decide whether the daemon "starts": a src/main.ts holding BROKEN is a daemon that never answers /health, and one holding CRASH LOOP
 * answers but is replaced by launchd again and again. */
export function world(r: Awaited<ReturnType<typeof repos>>, override: Partial<DeployDeps> = {}) {
  const w = {
    builds: [] as Array<{ args: string[]; head: string }>, posts: [] as Push[], notices: [] as string[][], restarts: 0, clock: 0, failBuilds: 0,
    // npm ci fails; the next probes of /health fail; something to do once a build has run.
    failCi: false, flaky: 0, afterBuild: undefined as (() => void) | undefined,
    // What GitHub says of a commit's checks (green unless a test says otherwise; a thrown error is a GitHub that cannot be read), and the commits asked.
    verdict: (() => ({ state: "success", failed: [] })) as (commit: string) => Checks, asked: [] as Array<[string, string]>,
    daemon: { pid: 100 as number | undefined, ok: true, flap: false, takes: true },
    saved: { outbox: [] } as DeployState,
    // The daemon's installed service file (none until a test installs one) and the texts the job wrote there, in order; `breakNext`
    // makes the next replacement fail after the file is written, as a launchctl that refuses to load it does.
    service: { installed: undefined as string | undefined, replaced: [] as string[], breakNext: false },
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
    // A service file holding BROKEN CONFIG is one under which the daemon never answers; kickstart keeps the file launchd holds.
    service: {
      installed: async () => w.service.installed,
      home: HOME,
      replace: async text => {
        w.service.replaced.push(text); w.service.installed = text;
        if (w.service.breakNext) { w.service.breakNext = false; throw new Error("Bootstrap failed: 5: Input/output error"); }
        const code = readFileSync(join(r.checkout, "src/main.ts"), "utf8");
        w.daemon.pid = (w.daemon.pid ?? 100) + 1000; w.daemon.ok = !code.includes("BROKEN") && !text.includes("BROKEN CONFIG"); w.daemon.flap = code.includes("CRASH LOOP");
      },
    },
    healthy: async () => { if (w.flaky > 0) { w.flaky--; return false; } return w.daemon.ok && w.daemon.pid !== undefined; },
    checks: async (repo, commit) => { w.asked.push([repo, commit]); return w.verdict(commit); },
    post: async push => { if (!w.daemon.takes) throw new Error("the daemon is down"); w.posts.push(push); },
    notify: (title, message) => { w.notices.push([title, message]); },
    load: () => structuredClone(w.saved), save: state => { w.saved = structuredClone(state); },
    sleep: async ms => { w.clock += ms; }, now: () => w.clock, log: () => {},
    waitMs: 90_000, stableMs: 5000, fetchRetryMs: 10_000,
  };
  return { w, deps, deploy: () => deployOnce({ ...deps, ...override }) };
}

export const BUILD = ["npm", "run", "-s", "build:web"];

/** A stand-in for `gh` in `bin` for scripts/deploy.ts: it logs its arguments and prints a file, which `answer` fills in the shape of
 * `gh api graphql` for the checks of one commit. The commit is green until a test says otherwise. */
export async function stubGh(dir: string, bin: string) {
  const calls = join(dir, "gh.log"), answerFile = join(dir, "gh-answer.json");
  writeFileSync(calls, "");
  await writeFile(join(bin, "gh"), `#!/bin/sh
echo "$@" >> "$STUB_GH_CALLS"
cat "$STUB_GH_ANSWER"
`);
  await chmod(join(bin, "gh"), 0o755);
  const check = (name: string, status: string, conclusion: string | null) => ({ __typename: "CheckRun", name, status, conclusion, startedAt: "2026-10-18T00:00:00Z", checkSuite: { id: "s1" } });
  const answer = (...nodes: object[]) => writeFileSync(answerFile, JSON.stringify({ data: { repository: { object: { oid: "x", statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes } } } } } }));
  answer(check("test", "COMPLETED", "SUCCESS"));
  return { env: { STUB_GH_CALLS: calls, STUB_GH_ANSWER: answerFile }, calls, answerFile, check, answer };
}

export const GREEN: Checks = { state: "success", failed: [] }, RUNNING: Checks = { state: "pending", failed: [] }, NONE: Checks = { state: "none", failed: [] };
export const RED = (...failed: string[]): Checks => ({ state: "failure", failed });
/** Nothing was moved, built, restarted or pushed. */
export const untouched = (r: Awaited<ReturnType<typeof repos>>, w: ReturnType<typeof world>["w"]) =>
  assert.deepEqual({ head: r.head(), builds: w.builds, restarts: w.restarts, posts: w.posts }, { head: r.first, builds: [], restarts: 0, posts: [] });


export type Repos = Awaited<ReturnType<typeof repos>>;
/** A deploy that did not end: git refuses its merge (a stale index.lock), going back is refused too, and the daemon still answers.
 * The checkout is on `first` with the lock gone and a pending record in the state; returns the commit that was being deployed. */
export async function leftUnfinished(r: Repos, deploy: () => Promise<DeployOutcome>) {
  const sha = r.land({ "src/a.ts": "a" }, "A");
  const lock = join(r.checkout, ".git/index.lock");
  writeFileSync(lock, "");
  assert.equal(await deploy(), "stuck");
  rmSync(lock);
  return sha;
}
