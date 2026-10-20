// The deploy job and the daemon's service file (src/deploy.ts, scripts/deploy.ts; docs/design.md, section 4, Deploying): the file launchd holds is
// replaced when the checkout's template renders to another text, and put back when the deploy it was replaced for fails. Real git
// repositories and fake launchd and daemon, and scripts/deploy.ts end to end with a stand-in for launchctl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { server } from "./helpers.ts";
import { FLAGS, identity, installedFor, repos, sh, stubGh, template, world } from "./deploy-world.ts";

// --- The daemon's service file (docs/design.md, Deploying) ---------------------------------------------------------------------------

const OLD_FILE = installedFor(""), NEW_FILE = installedFor(FLAGS);
const BAD_FILE = installedFor("<string>--BROKEN CONFIG</string>");

test("a template that renders to another text than the installed file replaces it as the deploy's restart, filled in with the values the installed file holds", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  w.service.installed = OLD_FILE;
  const sha = r.land({ "ops/wf-board.plist": template(FLAGS) }, "Add the flags (#1)");
  assert.equal(await deploy(), "deployed");
  assert.equal(r.head(), sha);
  // The text is the new template with the installed node, checkout, PATH and data directory (their XML escapes kept) and the job's own home.
  assert.deepEqual(w.service.replaced, [NEW_FILE]);
  assert.equal(w.restarts, 0, "kickstart would keep the file launchd holds: the replacement is the restart");
  assert.deepEqual(w.posts, [{ event: "deployed", version: sha, previous: r.first, changes: [`${r.short(sha)} Add the flags (#1)`], restarted: true, repo: r.repo }]);
  assert.deepEqual([w.saved.pending, w.saved.healthy], [undefined, sha]);
  assert.equal(await deploy(), "current", "the file now matches: the next run finds nothing to do");
  assert.equal(w.service.replaced.length, 1);
});

test("a file that already matches what the template renders to is left alone, and the restart is the one the changed paths call for", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  w.service.installed = OLD_FILE;
  assert.equal(await deploy(), "current", "a commit that is live with a matching file is nothing to do");
  r.land({ "src/a.ts": "a" }, "Change the code");
  assert.equal(await deploy(), "deployed");
  r.land({ "docs/design.md": "doc 2" }, "Change a document");
  assert.equal(await deploy(), "deployed");
  assert.deepEqual({ replaced: w.service.replaced, restarts: w.restarts }, { replaced: [], restarts: 1 }, "only the code change restarted, by kickstart");
  assert.equal(w.service.installed, OLD_FILE);
});

test("with no installed service file the job restarts as it always did, whatever the template says", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  r.land({ "ops/wf-board.plist": template(FLAGS) }, "Add the flags");
  assert.equal(await deploy(), "deployed");
  assert.deepEqual({ replaced: w.service.replaced, restarts: w.restarts }, { replaced: [], restarts: 1 });
});

test("a service file that does not start goes back with the code: the old text is written again, and the failure is pushed", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  w.service.installed = OLD_FILE;
  const bad = r.land({ "ops/wf-board.plist": template("<string>--BROKEN CONFIG</string>"), "src/a.ts": "a" }, "Break the config (#2)");
  assert.equal(await deploy(), "rolledBack");
  assert.equal(r.head(), r.first);
  assert.deepEqual(w.service.replaced, [BAD_FILE, OLD_FILE], "the new file, then the old text put back");
  assert.equal(w.service.installed, OLD_FILE);
  assert.equal(w.daemon.ok, true, "the daemon serves again, on the old code and the old file");
  assert.deepEqual(w.builds.map(b => b.head), [bad, r.first]);
  assert.equal(w.restarts, 0);
  assert.deepEqual(w.posts.map(p => [p.event, p.version, p.running]), [["deployFailed", bad, r.first]]);
  assert.deepEqual([w.saved.failed, w.saved.healthy, w.saved.pending], [bad, r.first, undefined]);
  // The commit is not tried again; a newer one with a good file is, and brings the new file in.
  assert.equal(await deploy(), "skipped");
  assert.equal(w.service.replaced.length, 2);
  const fix = r.land({ "ops/wf-board.plist": template(FLAGS) }, "Fix the config (#3)");
  assert.equal(await deploy(), "deployed");
  assert.equal(r.head(), fix);
  assert.deepEqual([w.service.installed, w.saved.failed], [NEW_FILE, undefined]);
});

test("a replacement that fails in launchctl is gone back from the same way: the old text is written again", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  w.service.installed = OLD_FILE; w.service.breakNext = true;
  r.land({ "ops/wf-board.plist": template(FLAGS) }, "Add the flags");
  assert.equal(await deploy(), "rolledBack");
  assert.deepEqual(w.service.replaced, [NEW_FILE, OLD_FILE]);
  assert.match(String(w.posts[0]!.reason), /Bootstrap failed: 5/);
  assert.equal(w.service.installed, OLD_FILE);
  assert.equal(w.daemon.ok, true);
});

test("a deploy that fails before the file was replaced puts nothing back", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  w.service.installed = OLD_FILE; w.failBuilds = 1;
  r.land({ "ops/wf-board.plist": template(FLAGS), "web/index.html": "page 2" }, "Add the flags");
  assert.equal(await deploy(), "rolledBack");
  assert.deepEqual({ replaced: w.service.replaced, restarts: w.restarts, installed: w.service.installed }, { replaced: [], restarts: 0, installed: OLD_FILE });
});

test("a replacement the job died in the middle of is finished first on the next run: the old text is written again", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const sha = r.land({ "ops/wf-board.plist": template(FLAGS) }, "Add the flags");
  // The job merged, wrote the new file and died before the daemon answered; the record kept the old text.
  sh(r.checkout, "fetch", "-q", "origin");
  sh(r.checkout, "merge", "-q", "--ff-only", sha);
  w.service.installed = NEW_FILE;
  w.saved.pending = { target: sha, to: r.first, restarted: true, heads: [sha], config: OLD_FILE };
  assert.equal(await deploy(), "rolledBack");
  assert.equal(r.head(), r.first);
  assert.deepEqual(w.service.replaced, [OLD_FILE]);
  assert.equal(w.restarts, 0);
  assert.match(String(w.posts[0]!.reason), /interrupted/);
});

test("a commit that is live already gets its service file replaced when only the file differs: nothing is moved, built or pushed", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  // The template reached the checkout in an earlier deploy, run by a job that did not replace service files yet.
  const sha = r.land({ "ops/wf-board.plist": template(FLAGS) }, "Add the flags");
  sh(r.checkout, "fetch", "-q", "origin");
  sh(r.checkout, "merge", "-q", "--ff-only", sha);
  w.service.installed = OLD_FILE;
  assert.equal(await deploy(), "reconfigured");
  assert.equal(r.head(), sha);
  assert.deepEqual(w.service.replaced, [NEW_FILE]);
  assert.deepEqual({ builds: w.builds.length, restarts: w.restarts, posts: w.posts.length, asked: w.asked.length }, { builds: 0, restarts: 0, posts: 0, asked: 0 }, "no build, no kickstart, no push, no ask of GitHub: the commit went live on its checks");
  assert.deepEqual([w.saved.pending, w.saved.healthy], [undefined, sha]);
  assert.equal(await deploy(), "current");
});

test("a service file of a live commit that does not start is put back, pushed once, and not tried again for that commit", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  const bad = r.land({ "ops/wf-board.plist": template("<string>--BROKEN CONFIG</string>") }, "Break the config");
  sh(r.checkout, "fetch", "-q", "origin");
  sh(r.checkout, "merge", "-q", "--ff-only", bad);
  w.service.installed = OLD_FILE;
  assert.equal(await deploy(), "rolledBack");
  assert.equal(r.head(), bad, "the code stays: it is what the daemon serves");
  assert.deepEqual(w.service.replaced, [BAD_FILE, OLD_FILE]);
  assert.equal(w.builds.length, 0, "going back rebuilt nothing");
  assert.deepEqual(w.posts.map(p => [p.event, p.version, p.changes]), [["deployFailed", bad, []]]);
  assert.equal(w.daemon.ok, true);
  assert.equal(await deploy(), "skipped");
  assert.equal(w.service.replaced.length, 2);
  assert.equal(w.posts.length, 1);
});

test("an installed file the job cannot read the values from is not replaced: nothing is moved, and one push says so however many runs find it so", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  w.service.installed = "<plist>edited by hand</plist>";
  r.land({ "src/a.ts": "a" }, "Change the code");
  assert.equal(await deploy(), "error");
  assert.equal(r.head(), r.first);
  assert.equal(await deploy(), "error");
  assert.deepEqual(w.posts.map(p => [p.event, p.version]), [["deployFailed", null]]);
  assert.match(String(w.posts[0]!.reason), /installed service file has no program/);
  assert.deepEqual({ replaced: w.service.replaced, restarts: w.restarts }, { replaced: [], restarts: 0 });
});

test("a template with a placeholder no value fills is not written to the service file", async t => {
  const r = await repos(t), { w, deploy } = world(r);
  w.service.installed = OLD_FILE;
  r.land({ "ops/wf-board.plist": template("<string>{{FLAGS}}</string>") }, "A typo in the template");
  assert.equal(await deploy(), "error");
  assert.match(String(w.posts[0]!.reason), /placeholder \{\{FLAGS\}\}/);
  assert.equal(w.service.replaced.length, 0);
  assert.equal(r.head(), r.first);
});

test("scripts/deploy.ts replaces the service file with launchctl: the file is written, the service stopped and waited for until launchd has let go of it, and only then loaded again", async t => {
  const r = await repos(t);
  const { port } = await server(t);
  const bin = join(r.dir, "bin"), calls = join(r.dir, "calls.log"), stub = join(r.dir, "launchd"), stateFile = join(r.dir, "state/deploy.json");
  const plistFile = join(r.dir, "LaunchAgents/test.label.plist");
  mkdirSync(bin); mkdirSync(stub); mkdirSync(dirname(plistFile)); writeFileSync(calls, "");
  // The daemon is loaded under pid 100 with the file the installer wrote; the home in it is the one this job renders with.
  writeFileSync(join(stub, "pid"), "100"); writeFileSync(join(stub, "loaded"), "");
  writeFileSync(plistFile, installedFor("", homedir()));
  const gh = await stubGh(r.dir, bin);
  // launchd as the Mac's: `list` fails (113) for a service it does not hold; `bootout` returns at once but the service stays listed while its
  // process exits (here, for two more answers of `list`); `bootstrap` of a service launchd still holds fails (5), and else loads and starts it.
  await writeFile(join(bin, "launchctl"), `#!/bin/sh
echo "launchctl $*" >> "$STUB_CALLS"
loaded() { [ -f "$STUB_DIR/loaded" ]; }
case "$1" in
  list)
    if ! loaded; then echo "Could not find service" >&2; exit 113; fi
    if [ -f "$STUB_DIR/exiting" ]; then
      n=$(cat "$STUB_DIR/exiting")
      if [ "$n" -le 0 ]; then rm -f "$STUB_DIR/loaded" "$STUB_DIR/exiting"; echo "Could not find service" >&2; exit 113; fi
      echo $((n - 1)) > "$STUB_DIR/exiting"
    fi
    printf '{\\n\\t"PID" = %s;\\n};\\n' "$(cat "$STUB_DIR/pid")" ;;
  bootout)
    if ! loaded; then echo "Boot-out failed: 3: No such process" >&2; exit 3; fi
    echo 2 > "$STUB_DIR/exiting" ;;
  bootstrap)
    if loaded; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    : > "$STUB_DIR/loaded"; echo $(( $(cat "$STUB_DIR/pid") + 1 )) > "$STUB_DIR/pid" ;;
  kickstart) echo $(( $(cat "$STUB_DIR/pid") + 1 )) > "$STUB_DIR/pid" ;;
esac
`);
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> "$STUB_CALLS"\n`);
  await chmod(join(bin, "launchctl"), 0o755); await chmod(join(bin, "npm"), 0o755);
  const run = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, "../scripts/deploy.ts")], { env: {
      ...process.env, ...identity, ...gh.env, PATH: `${bin}:${process.env.PATH}`, STUB_CALLS: calls, STUB_DIR: stub,
      WF_BOARD_REPO: r.checkout, WF_BOARD_PORT: String(port), WF_BOARD_LABEL: "test.label", WF_BOARD_DEPLOY_STATE: stateFile, WF_BOARD_PLIST: plistFile,
      WF_BOARD_DEPLOY_WAIT_MS: "20000", WF_BOARD_DEPLOY_STABLE_MS: "0",
    } });
    return stdout.trim().split("\n").at(-1)!.replace(/^\S+ /, "");
  };
  const calledLines = async () => (await readFile(calls, "utf8")).split("\n").filter(l => l && !l.startsWith("launchctl list"));
  const uid = process.getuid!();
  const stopAndLoad = [`launchctl bootout gui/${uid}/test.label`, `launchctl bootstrap gui/${uid} ${plistFile}`];

  // A merge that changes the template: the page is built, then the file is replaced, and `kickstart` is not used.
  r.land({ "ops/wf-board.plist": template(FLAGS) }, "Add the flags (#1)");
  assert.equal(await run(), "deployed");
  assert.deepEqual(await calledLines(), ["npm run -s build:web", ...stopAndLoad]);
  assert.equal(readFileSync(plistFile, "utf8"), installedFor(FLAGS, homedir()));
  assert.equal(readFileSync(join(stub, "pid"), "utf8").trim(), "101", "launchd started the daemon again, once");

  // The file matches: nothing is called but the reads of launchd's state.
  assert.equal(await run(), "current");
  assert.deepEqual(await calledLines(), ["npm run -s build:web", ...stopAndLoad]);

  // Someone put the old file back: the commit is live already, so only the file is replaced, and nothing is built.
  writeFileSync(plistFile, installedFor("", homedir()));
  assert.equal(await run(), "reconfigured");
  assert.deepEqual((await calledLines()).slice(3), stopAndLoad);
  assert.equal(readFileSync(plistFile, "utf8"), installedFor(FLAGS, homedir()));

  // A service launchd does not hold (it was stopped by hand): bootout fails, and that is nothing to stop; the file is loaded all the same.
  rmSync(join(stub, "loaded"));
  writeFileSync(plistFile, installedFor("", homedir()));
  assert.equal(await run(), "reconfigured");
  assert.deepEqual((await calledLines()).slice(5), stopAndLoad);
  assert.equal(readFileSync(plistFile, "utf8"), installedFor(FLAGS, homedir()));
  assert.equal(readFileSync(join(stub, "pid"), "utf8").trim(), "103");
});
