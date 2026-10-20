// The deploy job (docs/design.md, Running), src/deploy.ts over real git repositories with fake npm, launchd and daemon
// (test/deploy-world.ts): going back when the daemon does not come up, the checkout's states, the pushes and a deploy left
// unfinished. What is deployed and when is test/deploy.test.ts, scripts/deploy.ts end to end test/deploy-script.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PushRefused, deployOnce, refusesRequest } from "../src/deploy.ts";
import { BRANCH, sh, repos, world, BUILD, leftUnfinished } from "./deploy-world.ts";
import type { Repos } from "./deploy-world.ts";

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

test("a submodule checked out in the checkout does not make it look edited by hand when a merge moves its pointer", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  // A submodule repository with two commits; the main line holds it at the first and later moves the pointer to the second.
  const sub = join(r.dir, "skill");
  sh(r.dir, "init", "-q", "-b", BRANCH, sub);
  writeFileSync(join(sub, "f"), "1"); sh(sub, "add", "f"); sh(sub, "commit", "-q", "-m", "one");
  const one = sh(sub, "rev-parse", "HEAD");
  writeFileSync(join(sub, "f"), "2"); sh(sub, "commit", "-q", "-am", "two");
  const two = sh(sub, "rev-parse", "HEAD");
  const allow = ["-c", "protocol.file.allow=always"];
  sh(r.seed, ...allow, "submodule", "add", "-q", sub, "design/skill");
  sh(join(r.seed, "design/skill"), "checkout", "-q", one);
  r.publish("Add the submodule");
  assert.equal(await deploy(), "deployed");
  // Whoever initializes the submodule in the checkout (a check that needs it) leaves the checkout clean.
  sh(r.checkout, ...allow, "submodule", "update", "--init", "-q");
  assert.equal(sh(r.checkout, "status", "--porcelain", "--untracked-files=no"), "");
  sh(join(r.seed, "design/skill"), "fetch", "-q", "origin");
  sh(join(r.seed, "design/skill"), "checkout", "-q", two);
  r.publish("Move the submodule pointer (#2)");
  assert.equal(await deploy(), "deployed");
  // The merge moved the pointer and left the submodule's own files behind: git status calls that a change, and the job must not.
  assert.match(sh(r.checkout, "status", "--porcelain", "--untracked-files=no"), /design\/skill/);
  const later = r.land({ "src/a.ts": "a" }, "A (#3)");
  assert.equal(await deploy(), "deployed", "a pointer left behind by a merge is not an edit by hand");
  assert.equal(r.head(), later);
  assert.equal(w.posts.at(-1)!.event, "deployed");
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
