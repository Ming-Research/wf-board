// The deploy job (docs/design.md, Running): what the daemon reads of its checkout at runtime, and scripts/deploy.ts end to end
// against a real daemon with stand-ins for npm and launchctl only (test/deploy-world.ts). src/deploy.ts itself is
// test/deploy.test.ts and test/deploy-recover.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { NO_RESTART } from "../src/deploy.ts";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { createHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";
import { agentSocket, asArchitect, author, server } from "./helpers.ts";
import { cleanup } from "./cleanup.ts";
import { fakeSsh } from "./fake-ssh.ts";
import { REPO, identity, sh, repos, stubGh } from "./deploy-world.ts";

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
  // http.ts reads the page files, store.ts the board's data directory, wake.ts, liveness.ts, watch.ts, ci-watch.ts, runner-heartbeat.ts, unread-warm.ts
  // their state files (kept in that directory), credentials.ts the credentials file (kept outside the checkout and the data directory). A module that reads the checkout itself, such as docs/ or a template, would make a change there need a
  // restart: NO_RESTART (src/deploy.ts) must change first.
  assert.deepEqual(readers, ["ci-watch.ts", "credentials.ts", "http.ts", "liveness.ts", "runner-heartbeat.ts", "store.ts", "unread-warm.ts", "wake.ts", "watch.ts"]);
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
  cleanup(t, () => rm(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "dist"));
  const store = await Store.open(join(dir, "data"), { init: true, board: { title: "Synthetic board", projects: [{ name: "Whitefoot" }] } });
  const op = ops(store);
  const http = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: dir, createMcp: () => createMcpServer({ store, ops: op }) });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  cleanup(t, () => new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())));
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
  const gh = await stubGh(r.dir, bin);
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
      ...process.env, ...identity, ...gh.env, PATH: `${bin}:${process.env.PATH}`, STUB_CALLS: calls, STUB_PID: pidFile,
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
  // No item is held, so the failure goes to the architect's stream.
  const star = await agentSocket(t, url, "架构师");
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

test("scripts/deploy.ts: the checks are read through gh for the commit about to be deployed: running waits, red holds, green deploys", async t => {
  const r = await repos(t);
  const { port } = await server(t);
  const bin = join(r.dir, "bin"), pidFile = join(r.dir, "pid"), stateFile = join(r.dir, "state/deploy.json");
  mkdirSync(bin); writeFileSync(pidFile, "100");
  const { env, calls, answerFile, check, answer } = await stubGh(r.dir, bin);
  await writeFile(join(bin, "launchctl"), `#!/bin/sh
case "$1" in
  list) printf '{\\n\\t"PID" = %s;\\n};\\n' "$(cat "$STUB_PID")" ;;
  kickstart) echo $(( $(cat "$STUB_PID") + 1 )) > "$STUB_PID" ;;
esac
`);
  await writeFile(join(bin, "npm"), "#!/bin/sh\n");
  for (const name of ["launchctl", "npm"]) await chmod(join(bin, name), 0o755);
  const run = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, "../scripts/deploy.ts")], { env: {
      ...process.env, ...identity, ...env, PATH: `${bin}:${process.env.PATH}`, STUB_PID: pidFile,
      WF_BOARD_REPO: r.checkout, WF_BOARD_PORT: String(port), WF_BOARD_LABEL: "test.label", WF_BOARD_DEPLOY_STATE: stateFile,
      WF_BOARD_DEPLOY_WAIT_MS: "20000", WF_BOARD_DEPLOY_STABLE_MS: "0",
    } });
    return stdout.trim().split("\n").at(-1)!.replace(/^\S+ /, "");
  };

  const sha = r.land({ "src/a.ts": "a" }, "Add a (#1)");
  answer(check("test shard 1", "COMPLETED", "SUCCESS"), check("e2e", "IN_PROGRESS", null));
  assert.equal(await run(), "waiting");
  assert.equal(r.head(), r.first);
  // gh is asked as the daemon's look at GitHub asks it: the repository by owner and name, as strings, and now the commit's id.
  const [call] = readFileSync(calls, "utf8").trim().split("\n");
  assert.match(call!, /^api graphql -f owner=Ming-Research -f name=Whitefoot -f oid=[0-9a-f]{40} -f query=/);
  assert.ok(call!.includes(`oid=${sha} `), "the commit asked about is the one fetched");

  answer(check("test shard 1", "COMPLETED", "SUCCESS"), check("e2e", "COMPLETED", "FAILURE"));
  assert.equal(await run(), "held");
  assert.equal(r.head(), r.first, "a red check keeps the commit off the live board");

  // An answer that is not JSON is not green either.
  writeFileSync(answerFile, "");
  assert.equal(await run(), "unchecked");
  assert.equal(r.head(), r.first);

  answer(check("test shard 1", "COMPLETED", "SUCCESS"), check("e2e", "COMPLETED", "SUCCESS"));
  assert.equal(await run(), "deployed");
  assert.equal(r.head(), sha);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).healthy, sha);
});
