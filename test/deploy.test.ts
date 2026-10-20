// The deploy job (docs/design.md, Running), src/deploy.ts over real git repositories with fake npm, launchd and daemon
// (test/deploy-world.ts): what is deployed and when, by the checks GitHub reports, and what changed. The recovery, the checkout's
// states and the pushes are test/deploy-recover.test.ts, scripts/deploy.ts end to end test/deploy-script.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh, repos, world, BUILD, GREEN, RED, untouched, RUNNING, NONE } from "./deploy-world.ts";

test("with nothing new on the main line the job does nothing and says nothing", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  assert.equal(await deploy(), "current");
  assert.deepEqual({ builds: w.builds, posts: w.posts, restarts: w.restarts }, { builds: [], posts: [], restarts: 0 });
  assert.deepEqual(w.asked, [], "a main line that has not moved is not asked about");
});

test("a merged change is moved to, built, the daemon restarted once it is healthy, and the push names the version and the changes", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "src/ops.ts": "more" }, "Add more (#1)");
  assert.equal(await deploy(), "deployed");
  assert.equal(r.head(), sha);
  assert.deepEqual(w.asked, [[r.repo, sha]], "the checks asked for are those of the commit the job fetched");
  assert.deepEqual(w.builds, [{ args: BUILD, head: sha }], "built after the checkout moved");
  assert.equal(w.restarts, 1);
  assert.deepEqual(w.posts, [{ event: "deployed", version: sha, previous: r.first, changes: [`${r.short(sha)} Add more (#1)`], restarted: true, repo: r.repo }]);
  assert.equal(w.saved.healthy, sha);
  assert.deepEqual(w.saved.outbox, []);
  // The next run finds nothing to do.
  assert.equal(await deploy(), "current");
  assert.equal(w.restarts, 1); assert.equal(w.posts.length, 1);
});

// --- The checks of the commit decide whether it goes live (docs/design.md, Deploying) -----------------------------------------------

test("a commit whose checks are still running is not deployed; the next run asks again and deploys it once they passed", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "src/a.ts": "a" }, "A (#1)");
  w.verdict = () => RUNNING;
  assert.equal(await deploy(), "waiting");
  untouched(r, w);
  assert.equal(await deploy(), "waiting", "and again");
  untouched(r, w);
  w.verdict = () => GREEN;
  assert.equal(await deploy(), "deployed");
  assert.equal(r.head(), sha);
  assert.deepEqual(w.posts.map(p => p.event), ["deployed"]);
  assert.equal(w.saved.waiting, undefined, "the wait is forgotten once it is over");
});

test("a commit with no checks yet (GitHub has not registered the run) is waited for as well, not taken for green", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  r.land({ "src/a.ts": "a" }, "A (#1)");
  w.verdict = () => NONE;
  assert.equal(await deploy(), "waiting");
  untouched(r, w);
});

test("a commit with a red check is not deployed and not pushed: the board's look at the main line already tells who holds it", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "src/a.ts": "a" }, "A (#1)");
  w.verdict = () => RED("nkey time-writing");
  assert.equal(await deploy(), "held");
  untouched(r, w);
  assert.equal(await deploy(), "held", "every run asks again, so a rerun that turned green is found");
  assert.equal(w.asked.length, 2);
  // The failed check is run again and passes: the same commit goes live.
  w.verdict = () => GREEN;
  assert.equal(await deploy(), "deployed");
  assert.equal(r.head(), sha);
});

test("a red commit is passed over by a newer green one, which brings both live in one deploy and one push", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const red = r.land({ "src/a.ts": "broken" }, "Break (#1)");
  w.verdict = () => RED("test shard 3");
  assert.equal(await deploy(), "held");
  untouched(r, w);
  const fix = r.land({ "src/a.ts": "fixed" }, "Fix (#2)");
  w.verdict = commit => commit === fix ? GREEN : RED("test shard 3");
  assert.equal(await deploy(), "deployed");
  assert.equal(r.head(), fix);
  assert.deepEqual(w.asked.map(([, commit]) => commit), [red, fix], "each run asks about the main line's head and nothing older");
  assert.deepEqual(w.posts, [{ event: "deployed", version: fix, previous: r.first, changes: [`${r.short(fix)} Fix (#2)`, `${r.short(red)} Break (#1)`], restarted: true, repo: r.repo }]);
});

test("checks that cannot be read are not green: nothing is deployed and one push says so, however many runs fail the same way", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "src/a.ts": "a" }, "A (#1)");
  w.verdict = () => { throw new Error("gh failed: not logged in"); };
  assert.equal(await deploy(), "unchecked");
  assert.equal(r.head(), r.first); assert.equal(w.builds.length, 0);
  assert.deepEqual(w.posts.map(p => [p.event, p.version, p.running]), [["deployFailed", sha, r.first]]);
  assert.match(String(w.posts[0]!.reason), /could not be read.*gh failed: not logged in/);
  assert.equal(await deploy(), "unchecked");
  assert.equal(w.posts.length, 1, "the same trouble is not pushed twice");
  // Readable again: the commit goes live, and the trouble is forgotten, so a later one is news again.
  w.verdict = () => GREEN;
  assert.equal(await deploy(), "deployed");
  assert.equal(w.saved.told, undefined);
  const next = r.land({ "src/b.ts": "b" }, "B (#2)");
  w.verdict = () => { throw new Error("gh failed: not logged in"); };
  assert.equal(await deploy(), "unchecked");
  assert.deepEqual(w.posts.map(p => p.event), ["deployFailed", "deployed", "deployFailed"]);
  assert.equal(w.posts[2]!.version, next);
});

test("a remote address that names no repository leaves the checks unreadable, so nothing is deployed", async t => {
  const r = await repos(t), plain = world(r).deps.git;
  const { w, deploy } = world(r, { git: args => args[0] === "remote" ? Promise.resolve("nonsense\n") : plain(args) });
  r.land({ "src/a.ts": "a" }, "A (#1)");
  w.verdict = () => { throw new Error("must not be asked"); };
  assert.equal(await deploy(), "unchecked");
  assert.deepEqual(w.asked, []);
});

test("checks still unfinished an hour after the job first saw the commit are pushed once; they are not given up on", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "src/a.ts": "a" }, "A (#1)");
  w.verdict = () => RUNNING;
  assert.equal(await deploy(), "waiting");
  w.clock += 59 * 60_000;
  assert.equal(await deploy(), "waiting");
  assert.equal(w.posts.length, 0, "not yet an hour");
  w.clock += 2 * 60_000;
  assert.equal(await deploy(), "waiting");
  assert.deepEqual(w.posts.map(p => [p.event, p.version]), [["deployFailed", sha]]);
  assert.match(String(w.posts[0]!.reason), /not finished after 61 minutes.*still running/);
  w.clock += 60_000;
  assert.equal(await deploy(), "waiting");
  assert.equal(w.posts.length, 1, "once per commit");
  // When they do pass the commit goes live.
  w.verdict = () => GREEN;
  assert.equal(await deploy(), "deployed");
});

test("the hour counts from the newest commit: a commit that arrives while the old one waits starts its own time", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  r.land({ "src/a.ts": "a" }, "A (#1)");
  w.verdict = () => RUNNING;
  assert.equal(await deploy(), "waiting");
  w.clock += 50 * 60_000;
  r.land({ "src/b.ts": "b" }, "B (#2)");
  w.clock += 20 * 60_000;
  assert.equal(await deploy(), "waiting");
  assert.equal(w.posts.length, 0, "B has waited 0 minutes, A's 70 do not count against it");
});

test("a checkout the job may not move is refused before anything is asked of GitHub", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  writeFileSync(join(r.checkout, "README.md"), "someone's edit");
  r.land({ "src/a.ts": "a" }, "A");
  assert.equal(await deploy(), "refused");
  assert.deepEqual(w.asked, []);
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
