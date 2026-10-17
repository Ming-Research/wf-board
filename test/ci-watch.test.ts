// The look at the checks (docs/design.md, Watching GitHub, The look at the checks): a pull request's finished checks reach the
// session holding its item as a message, over conditional requests that GitHub answers 304 when nothing changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { restSource } from "../src/ci-source.ts";
import { CiWatch, ciText, judge } from "../src/ci-watch.ts";
import type { CheckReading } from "../src/github.ts";
import { Wake } from "../src/wake.ts";
import { agentSocket, asArchitect, server } from "./helpers.ts";

// --- A fake GitHub ------------------------------------------------------------------------------------------------------------
// It answers the REST paths the look reads, with the ETag GitHub would give: one that depends on the body and on the Accept
// header, as GitHub's does (the Vary header names Accept), and 304 for a request that carries it.

const REPO = "Ming-Research/wf-board", PREFIX = `/repos/${REPO}`;
interface FakeRun { name: string; status: string; conclusion: string | null; started_at: string | null; suite: number }
interface Exchange { path: string; ifNoneMatch: string | null; accept: string | null; status: number }
function fakeGithub(repo = REPO) {
  const gh = {
    pulls: new Map<number, { commit: string; state: string; draft: boolean; merged: boolean }>(),
    runs: new Map<string, FakeRun[]>(),
    statuses: new Map<string, Array<{ context: string; state: string }>>(),
    log: [] as Exchange[],
    quota: 5000,
    /** Set to answer every request with this status (and headers), as GitHub does when it refuses. */
    refuse: undefined as { status: number; headers: Record<string, string> } | undefined,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)), headers = init?.headers as Record<string, string>, path = url.pathname + url.search;
      const accept = headers.accept ?? null, inm = headers["if-none-match"] ?? null;
      assert.ok(headers.authorization?.startsWith("Bearer "), "every request is signed");
      const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => {
        gh.log.push({ path, ifNoneMatch: inm, accept, status });
        return new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { "x-ratelimit-remaining": String(gh.quota), ...extra } });
      };
      if (gh.refuse) return reply(gh.refuse.status, { message: "refused" }, gh.refuse.headers);
      let body: unknown;
      let m: RegExpExecArray | null;
      if ((m = new RegExp(`^/repos/${repo}/pulls/(\\d+)$`).exec(url.pathname))) {
        const pull = gh.pulls.get(Number(m[1]));
        if (!pull) return reply(404, { message: "Not Found" });
        body = { number: Number(m[1]), title: `PR ${m[1]}`, html_url: `https://github.com/${repo}/pull/${m[1]}`, draft: pull.draft, state: pull.state, merged: pull.merged, head: { sha: pull.commit } };
      } else if ((m = new RegExp(`^/repos/${repo}/commits/([0-9a-f]+)/check-runs$`).exec(url.pathname))) {
        assert.equal(url.searchParams.get("filter"), "all", "every attempt of every round is read");
        const runs = gh.runs.get(m[1]!) ?? [];
        body = { total_count: runs.length, check_runs: runs.map(r => ({ name: r.name, status: r.status, conclusion: r.conclusion, started_at: r.started_at, check_suite: { id: r.suite } })) };
      } else if ((m = new RegExp(`^/repos/${repo}/commits/([0-9a-f]+)/status$`).exec(url.pathname))) {
        const statuses = gh.statuses.get(m[1]!) ?? [];
        body = { state: "pending", total_count: statuses.length, statuses };
      } else return reply(404, { message: "Not Found" });
      const etag = `"${createHash("sha1").update(JSON.stringify(body) + (accept ?? "")).digest("hex")}"`;
      if (inm === etag) return reply(304, null, { etag });
      gh.quota--;
      return reply(200, body, { etag });
    }) as typeof fetch,
  };
  return gh;
}
type Github = ReturnType<typeof fakeGithub>;
const run = (name: string, conclusion: string | null, status = conclusion === null ? "in_progress" : "completed", suite = 1, started_at: string | null = "2026-10-17T10:00:00Z"): FakeRun => ({ name, status, conclusion, started_at, suite });

// --- The board ----------------------------------------------------------------------------------------------------------------

async function fixture(t: { after(fn: () => void | Promise<void>): void }, { engineer = true }: { engineer?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-ci-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [{ name: "wf-board", repo: REPO }, { name: "Architect" }, { name: "PM" }] } });
  const op = ops(store);
  await op.createItem({ ...asArchitect, key: "watch", group: "wf-board", priority: "P1", title: "Watch it", head: "**问题**：x\n\n## 改动\n\n[wf-board#23](https://github.com/Ming-Research/wf-board/pull/23)：a change", accept: "验收通过" });
  if (engineer) await op.dispatchStart({ ...asArchitect, id: "watch", role: "工程师", level: 2, model: "Sonnet", agent: "watch-eng", agentId: "agent-1" });
  return { dir, store, op };
}
const messages = (store: Store) => Object.values(store.snapshot().messages ?? {}).flatMap(day => day.messages);
async function stateFile(t: { after(fn: () => void | Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-ci-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "state", "ci-watch.json");
}
const COMMIT = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const watchOver = (fx: { store: Store; op: ReturnType<typeof ops> }, gh: Github, extra: { stateFile?: string; now?: () => number } = {}) =>
  new CiWatch({ store: fx.store, ops: fx.op, ci: restSource({ token: async () => "token", fetch: gh.fetch, ...(extra.now ? { now: extra.now } : {}) }), ...extra });

// --- What is told, and when -------------------------------------------------------------------------------------------------

test("the next look after a PR's checks have all finished sends the holder one message with the PR, the commit and the result; before that nothing", async t => {
  const fx = await fixture(t), gh = fakeGithub(), watch = watchOver(fx, gh);
  gh.pulls.set(23, { commit: COMMIT, state: "open", draft: true, merged: false });
  // The first look: one check still runs.
  gh.runs.set(COMMIT, [run("check", "success"), run("test", null)]);
  await watch.poll();
  // A red check while another still runs is not the end of the round.
  gh.runs.set(COMMIT, [run("check", "success"), run("test", "failure", "completed"), run("e2e", null, "queued")]);
  await watch.poll();
  assert.deepEqual(messages(fx.store), [], "unfinished: not told, although one check is red");
  // The last one finishes; the very next look tells.
  gh.runs.set(COMMIT, [run("check", "success"), run("test", "failure", "completed"), run("e2e", "success")]);
  await watch.poll();
  const [told, ...rest] = messages(fx.store);
  assert.equal(rest.length, 0);
  assert.deepEqual({ from: told!.from, project: told!.project, to: told!.to, item: told!.item }, { from: "看板", project: "wf-board", to: "watch-eng", item: "watch" });
  assert.equal(told!.text, `CI 跑完：${REPO}#23 提交 a1b2c3d 有失败：test`, "the PR, the commit and the result, in one line; a draft's checks count too");
  // Green on the next commit.
  gh.pulls.set(23, { commit: "b2c3d4e5f6a1", state: "open", draft: false, merged: false });
  gh.runs.set("b2c3d4e5f6a1", [run("check", "success"), run("test", "success")]);
  await watch.poll();
  assert.deepEqual(messages(fx.store).map(m => m.text), [`CI 跑完：${REPO}#23 提交 a1b2c3d 有失败：test`, `CI 跑完：${REPO}#23 提交 b2c3d4e 全部通过`]);
});

test("a look that finds nothing changed asks with the ETag it was given, gets 304 and tells nothing again", async t => {
  const fx = await fixture(t), gh = fakeGithub(), watch = watchOver(fx, gh);
  gh.pulls.set(23, { commit: COMMIT, state: "open", draft: false, merged: false });
  gh.runs.set(COMMIT, [run("check", "success"), run("test", null)]);
  await watch.poll();
  gh.runs.set(COMMIT, [run("check", "success"), run("test", "success")]);
  await watch.poll();
  assert.equal(messages(fx.store).length, 1);
  const quota = gh.quota, asked = gh.log.length;
  await watch.poll(); await watch.poll();
  const again = gh.log.slice(asked);
  assert.equal(again.length, 6, "three requests (the PR, its checks, its statuses) in each of two looks");
  assert.ok(again.every(r => r.status === 304), "GitHub answers 304 to each");
  assert.ok(again.every(r => r.ifNoneMatch !== null && /^"[0-9a-f]+"$/.test(r.ifNoneMatch)), "each carries the ETag of the earlier answer");
  assert.equal(new Set(gh.log.map(r => r.accept)).size, 1, "the Accept header is the same every time: the ETag is the answer to those headers");
  assert.equal(gh.quota, quota, "a 304 is not counted");
  assert.equal(messages(fx.store).length, 1, "and nothing is told again");
  assert.equal(watch.status().remaining, quota, "the quota left, as the newest answer says, is on /health");
});

test("a round on the same commit is told when it finishes again: the full CI a hand starts writes the status full-ci", async t => {
  const fx = await fixture(t), gh = fakeGithub(), watch = watchOver(fx, gh);
  gh.pulls.set(23, { commit: COMMIT, state: "open", draft: false, merged: false });
  gh.runs.set(COMMIT, [run("test", null)]);
  await watch.poll();
  gh.runs.set(COMMIT, [run("test", "success")]);
  await watch.poll();
  assert.equal(messages(fx.store).length, 1);
  // The engineer starts the full CI: its status is pending until the run ends.
  gh.statuses.set(COMMIT, [{ context: "full-ci", state: "pending" }]);
  await watch.poll();
  assert.equal(messages(fx.store).length, 1, "pending: not over");
  gh.statuses.set(COMMIT, [{ context: "full-ci", state: "failure" }]);
  await watch.poll();
  assert.deepEqual(messages(fx.store).map(m => m.text.slice(m.text.indexOf("提交"))), ["提交 a1b2c3d 全部通过", "提交 a1b2c3d 有失败：full-ci"]);
  gh.statuses.set(COMMIT, [{ context: "full-ci", state: "success" }]);
  await watch.poll(); await watch.poll();
  assert.equal(messages(fx.store).length, 3, "a run again on the same commit is a new round, told once");
});

test("a pull request with no checks, or only skipped ones, is not told", async t => {
  const fx = await fixture(t), gh = fakeGithub(), watch = watchOver(fx, gh);
  gh.pulls.set(23, { commit: COMMIT, state: "open", draft: false, merged: false });
  await watch.poll();
  gh.runs.set(COMMIT, [run("gate", "skipped", "completed")]);
  await watch.poll();
  assert.deepEqual(messages(fx.store), []);
});

test("nobody holds the item, or only a reviewer: nothing is sent; a closed or merged PR is no longer asked about", async t => {
  const fx = await fixture(t, { engineer: false }), gh = fakeGithub(), watch = watchOver(fx, gh);
  await fx.op.dispatchStart({ ...asArchitect, id: "watch", role: "审查", level: 2, model: "Sonnet", agent: "watch-review", agentId: "agent-2" });
  gh.pulls.set(23, { commit: COMMIT, state: "open", draft: false, merged: false });
  gh.runs.set(COMMIT, [run("test", null)]);
  await watch.poll();
  gh.runs.set(COMMIT, [run("test", "success")]);
  await watch.poll();
  assert.deepEqual(messages(fx.store), [], "a review holds nothing");
  gh.pulls.set(23, { commit: COMMIT, state: "closed", draft: false, merged: true });
  const asked = gh.log.length;
  await watch.poll();
  assert.deepEqual(gh.log.slice(asked).map(r => r.path), [`${PREFIX}/pulls/23`], "only the PR itself, to see that it is closed");
  await watch.poll();
  assert.equal(gh.log.length, asked + 2, "and so on every look; no checks of a closed PR are read");
});

test("a message goes to each session holding an item that names the PR, once", async t => {
  const fx = await fixture(t), gh = fakeGithub(), watch = watchOver(fx, gh);
  await fx.op.createItem({ ...asArchitect, key: "twin", group: "wf-board", priority: "P1", title: "Twin", head: "## 改动\n\nMing-Research/wf-board#23", accept: "验收通过" });
  await fx.op.dispatchStart({ ...asArchitect, id: "twin", role: "工程师", level: 2, model: "Sonnet", agent: "twin-eng", agentId: "agent-3" });
  gh.pulls.set(23, { commit: COMMIT, state: "open", draft: false, merged: false });
  gh.runs.set(COMMIT, [run("test", null)]);
  await watch.poll();
  gh.runs.set(COMMIT, [run("test", "success")]);
  await watch.poll();
  assert.deepEqual(messages(fx.store).map(m => [m.to, m.item]).sort(), [["twin-eng", "twin"], ["watch-eng", "watch"]]);
});

// --- Restarts and the first look --------------------------------------------------------------------------------------------

test("the first look at a repository tells nothing of a round already over; one that ends later is told, also after a restart", async t => {
  const fx = await fixture(t), gh = fakeGithub(), file = await stateFile(t);
  gh.pulls.set(23, { commit: COMMIT, state: "open", draft: false, merged: false });
  gh.runs.set(COMMIT, [run("test", "success")]);
  await watchOver(fx, gh, { stateFile: file }).poll();
  assert.deepEqual(messages(fx.store), [], "finished before the board looked: the backlog, not news");
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual([saved.looked, saved.pulls[`${REPO.toLowerCase()}#23`]], [[REPO.toLowerCase()], { commit: COMMIT, told: "success" }]);
  // A restart in the middle of a round: the new watch has no ETags, and finds the round over.
  gh.runs.set(COMMIT, [run("test", "success"), run("e2e", null)]);
  await watchOver(fx, gh, { stateFile: file }).poll();
  gh.runs.set(COMMIT, [run("test", "success"), run("e2e", "success")]);
  const restarted = watchOver(fx, gh, { stateFile: file });
  await restarted.poll();
  assert.equal(messages(fx.store).length, 1, "seen unfinished before the restart, finished after it: told");
  await watchOver(fx, gh, { stateFile: file }).poll();
  assert.equal(messages(fx.store).length, 1, "and not told again by the next restart");
  // A PR that is new to a repository already looked at, and finished when first seen, is news.
  await fx.op.createItem({ ...asArchitect, key: "later", group: "wf-board", priority: "P1", title: "Later", head: "## 改动\n\nMing-Research/wf-board#24", accept: "验收通过" });
  await fx.op.dispatchStart({ ...asArchitect, id: "later", role: "工程师", level: 2, model: "Sonnet", agent: "later-eng", agentId: "agent-4" });
  gh.pulls.set(24, { commit: "c3d4e5f6a1b2", state: "open", draft: false, merged: false });
  gh.runs.set("c3d4e5f6a1b2", [run("test", "success")]);
  await restarted.poll();
  assert.deepEqual(messages(fx.store).slice(1).map(m => [m.to, m.text]), [["later-eng", `CI 跑完：${REPO}#24 提交 c3d4e5f 全部通过`]]);
});

test("a state file that cannot be read costs one baseline look, not the watch", async t => {
  const fx = await fixture(t), gh = fakeGithub(), file = await stateFile(t);
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, "{ not json");
  gh.pulls.set(23, { commit: COMMIT, state: "open", draft: false, merged: false });
  gh.runs.set(COMMIT, [run("test", "success")]);
  await watchOver(fx, gh, { stateFile: file }).poll();
  assert.equal(JSON.parse(await readFile(file, "utf8")).pulls[`${REPO.toLowerCase()}#23`].told, "success", "written anew");
});

// --- GitHub refuses ---------------------------------------------------------------------------------------------------------------

test("GitHub's refusal to answer is a problem of the repository, shown on /health; no request is made until the time it names, then the look goes on", async t => {
  const fx = await fixture(t), gh = fakeGithub();
  let clock = Date.parse("2026-10-17T12:00:00Z");
  const watch = watchOver(fx, gh, { now: () => clock });
  gh.pulls.set(23, { commit: COMMIT, state: "open", draft: false, merged: false });
  gh.runs.set(COMMIT, [run("test", null)]);
  gh.refuse = { status: 403, headers: { "retry-after": "90" } };
  await watch.poll();
  assert.match(watch.status().problems[REPO.toLowerCase()] ?? "", /403.*no request until 2026-10-17T12:01:30/);
  const asked = gh.log.length;
  clock += 60_000; await watch.poll();
  assert.equal(gh.log.length, asked, "still within the 90 seconds GitHub asked for");
  gh.refuse = undefined; clock += 31_000; await watch.poll();
  assert.deepEqual(watch.status().problems, {}, "the problem clears with the next good look");
  gh.runs.set(COMMIT, [run("test", "success")]);
  await watch.poll();
  assert.equal(messages(fx.store).length, 1, "and the look tells what it finds");
  // A 403 that is no rate limit is that request's failure, not a stop for all.
  gh.refuse = { status: 403, headers: {} };
  await watch.poll();
  const refused = gh.log.length;
  await watch.poll();
  assert.ok(gh.log.length > refused, "asked again at the next look");
  // Rate limit by the quota: out of requests, until the reset time.
  gh.refuse = { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(clock / 1000) + 600) } };
  gh.quota = 0;
  await watch.poll();
  assert.match(watch.status().problems[REPO.toLowerCase()] ?? "", /no request until 2026-10-17T12:11:/);
});

test("a PR number GitHub does not know is no problem: it is forgotten like a closed one", async t => {
  const fx = await fixture(t), gh = fakeGithub(), watch = watchOver(fx, gh);
  await watch.poll();
  assert.deepEqual(watch.status().problems, {});
  assert.deepEqual(messages(fx.store), []);
});

// --- The pieces -------------------------------------------------------------------------------------------------------------------

test("a round is told once: when it ends, not again until something is seen unfinished, the commit changes or the result differs; the first look only remembers", () => {
  const reading = (state: CheckReading["state"], unfinished = false, failed: string[] = []): CheckReading => ({ state, failed, unfinished });
  const green = { commit: "c1", told: "success" }, red = { commit: "c1", told: "failure:test" };
  assert.deepEqual(judge(undefined, "c1", reading("success"), false), { next: green, tell: true });
  assert.deepEqual(judge(green, "c1", reading("success"), false), { next: green, tell: false });
  assert.deepEqual(judge(green, "c1", reading("pending", true), false), { next: { commit: "c1", told: null }, tell: false }, "something runs again: a round is awaited");
  assert.equal(judge({ commit: "c1", told: null }, "c1", reading("success"), false).tell, true, "and told when it ends, whatever the result was before");
  assert.equal(judge(green, "c1", reading("failure", true, ["test"]), false).tell, false, "red but unfinished");
  assert.equal(judge(green, "c1", reading("failure", false, ["test"]), false).tell, true, "the result differs from the one told, though no look saw it unfinished");
  assert.equal(judge(red, "c1", reading("failure", false, ["test"]), false).tell, false, "the same red");
  assert.equal(judge(red, "c1", reading("failure", false, ["e2e", "test"]), false).tell, true, "another check failed too");
  assert.equal(judge(green, "c2", reading("success"), false).tell, true, "a new commit");
  assert.equal(judge({ commit: "c1", told: null }, "c1", reading("none"), false).tell, false, "nothing ran");
  assert.deepEqual(judge(undefined, "c1", reading("success"), true), { next: green, tell: false }, "baseline");
  assert.deepEqual(judge(undefined, "c1", reading("pending", true), true), { next: { commit: "c1", told: null }, tell: false }, "baseline, unfinished: told when it ends");
  assert.equal(judge({ commit: "c1", told: null }, "c1", reading("success"), true).tell, true, "a record from an earlier run of the board is news even at a baseline");
});

test("the message is one line of at most 150 characters; failed check names that do not fit become a count", () => {
  const names = ["test", "e2e"], reading = (failed: string[]): CheckReading => ({ state: "failure", failed, unfinished: false });
  assert.equal(ciText(REPO, 7, COMMIT, { state: "success", failed: [], unfinished: false }), `CI 跑完：${REPO}#7 提交 a1b2c3d 全部通过`);
  assert.equal(ciText(REPO, 7, COMMIT, reading(names)), `CI 跑完：${REPO}#7 提交 a1b2c3d 有失败：test、e2e`);
  const long = ciText(REPO, 7, COMMIT, reading(Array.from({ length: 30 }, (_, i) => `check-number-${i}`)));
  assert.ok([...long].length <= 150);
  assert.match(long, /有 30 项失败/);
});

test("the token is read again, once, after a 401; a bad repository, commit or number is refused before any request", async () => {
  const seen: Array<string | undefined> = [];
  let tokens = 0;
  const answers = [new Response("{}", { status: 401 }), new Response(JSON.stringify({ number: 1, title: "t", html_url: "u", state: "open", head: { sha: "abcdef1" } }), { status: 200 })];
  const fetchFake = (async (_url: string, init: RequestInit) => { seen.push((init.headers as Record<string, string>).authorization); return answers.shift()!; }) as unknown as typeof fetch;
  const source = restSource({ token: async () => `t${++tokens}`, fetch: fetchFake });
  assert.deepEqual(await source.pull("a/b", 1), { number: 1, title: "t", url: "u", draft: false, open: true, commit: "abcdef1" });
  assert.deepEqual(seen, ["Bearer t1", "Bearer t2"]);
  await assert.rejects(source.checks("nonsense", "abcdef1"), /expected Owner\/Name/);
  await assert.rejects(source.checks("a/b", "not-a-commit"), /hexadecimal/);
  await assert.rejects(source.pull("a/b", 0), /positive integer/);
  assert.equal(seen.length, 2, "none of them was asked");
});

// --- Inside the server ------------------------------------------------------------------------------------------------------------

test("the look runs inside the server: /health reports it, and the message reaches the holder's stream", async t => {
  const WHITEFOOT = "Ming-Research/Whitefoot", gh = fakeGithub(WHITEFOOT), wake = new Wake();
  let watch: CiWatch | undefined;
  const { api, url, op, store } = await server(t, { wake, ci: fx => (watch = new CiWatch({ store: fx.store, ops: fx.op, ci: restSource({ token: async () => "token", fetch: gh.fetch }) })) });
  const until = async (done: () => boolean) => { for (let i = 0; i < 300 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(done(), "timed out"); };
  await until(() => watch!.status().polledAt !== undefined);
  // The fixture's item a is a Whitefoot item: name a PR of it, and let a session hold it.
  await op.updateItem({ author: "Whitefoot", id: "a", rev: store.snapshot().items.a!.rev, head: "背景\n\n## 改动\n\nMing-Research/Whitefoot#7", reason: "name the PR" });
  await op.dispatchStart({ ...asArchitect, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "a-eng", agentId: "agent-1" });
  gh.pulls.set(7, { commit: COMMIT, state: "open", draft: false, merged: false });
  gh.runs.set(COMMIT, [run("test", null)]);
  const socket = await agentSocket(t, url, "a-eng");
  await watch!.poll();
  gh.runs.set(COMMIT, [run("test", "success")]);
  await watch!.poll();
  await until(() => socket.events().length === 1);
  assert.deepEqual(socket.events().map(f => [f.event, f.from, f.item, f.text]), [["message", "看板", "a", `CI 跑完：${WHITEFOOT}#7 提交 a1b2c3d 全部通过`]]);
  const health = await api("/health", undefined, "GET");
  assert.equal(health.status, 200);
  assert.ok((health.data as { ci: { polledAt: string } }).ci.polledAt, "the look is shown");
});
