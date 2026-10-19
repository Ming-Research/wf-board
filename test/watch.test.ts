import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { changesSection, rules } from "../src/rules.ts";
import { Wake } from "../src/wake.ts";
import { GithubWatch, decide, mergeRows, mergedRows, pushKey, watchedPulls } from "../src/watch.ts";
import { COMMIT_CHECKS_QUERY, ghCommitChecks, ghSource, parseResponse, queryText, summarize } from "../src/github.ts";
import type { Checks, Gh, GithubSource, PullState, RepoState } from "../src/github.ts";
import { ARCHITECT_SESSION } from "../src/model.ts";
import { agentSocket, asArchitect, server } from "./helpers.ts";

// --- GitHub's answer -------------------------------------------------------------------------------------------------------------
// The shapes below are those of `gh api graphql` with the query from queryText, read from a live answer for a private repository.

// `at` is when the run started (null: not yet); `suite` the round of checks it belongs to (one workflow run for one event, and its reruns).
const run = (name: string, conclusion: string | null, status = "COMPLETED", { at = null, suite = "s1" }: { at?: string | null; suite?: string } = {}) => ({
  __typename: "CheckRun", name, status, conclusion, startedAt: at, checkSuite: { id: suite }, detailsUrl: `https://example.invalid/${name}`,
});
// `state` is GitHub's own roll-up, which counts a cancelled run as a failure; it is not what the board reads.
const rollup = (state: string, ...nodes: unknown[]) => ({ state, contexts: { pageInfo: { hasNextPage: false }, nodes } });
const answer = (repository: object) => JSON.stringify({ data: { repository } });
const prNode = (number: number, fields: object = {}, checks: unknown = rollup("SUCCESS", run("test", "SUCCESS"), run("test", "SUCCESS"), run("e2e", "SUCCESS"))) => ({
  number, title: `PR ${number}`, url: `https://github.com/Ming-Research/wf-board/pull/${number}`, isDraft: false, createdAt: "2026-01-01T00:00:00Z", baseRefName: "claude/first-board", headRefOid: `c${number}`, mergeable: "MERGEABLE",
  commits: { nodes: [{ commit: { statusCheckRollup: checks } }] }, ...fields,
});

test("a GitHub answer is read into main line, open PRs and named PRs; a roll-up gives the state and the checks that failed", () => {
  const text = answer({
    main: { name: "claude/first-board", target: { oid: "abc", messageHeadline: "Merge pull request #23 from Ming-Research/watch", statusCheckRollup: rollup("FAILURE", run("test", "SUCCESS"), run("e2e", "FAILURE"), run("e2e", "TIMED_OUT"), { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" }) } },
    pullRequests: { pageInfo: { hasNextPage: true }, nodes: [
      prNode(1),
      prNode(2, { isDraft: true, mergeable: "UNKNOWN" }, rollup("PENDING", run("test", null, "IN_PROGRESS"), run("e2e", "SUCCESS"))),
      prNode(3, { mergeable: "CONFLICTING", baseRefName: "other" }, null),
    ] },
    p20: { number: 20, state: "MERGED", mergedAt: "2026-10-16T01:02:03Z", url: "https://github.com/Ming-Research/wf-board/pull/20" },
    p21: { number: 21, state: "OPEN", mergedAt: null, url: "https://github.com/Ming-Research/wf-board/pull/21" },
    p22: null,
  });
  const state = parseResponse("Ming-Research/wf-board", text);
  assert.deepEqual(state.main, { branch: "claude/first-board", commit: "abc", subject: "Merge pull request #23 from Ming-Research/watch", checks: { state: "failure", failed: ["ci/legacy", "e2e"] } }, "a name is listed once, a skipped or passed check not at all; statuses before runs; the commit's first message line is read");
  assert.equal(state.truncated, true);
  assert.deepEqual(state.pulls.map(p => [p.number, p.draft, p.base, p.commit, p.mergeable, p.checks.state, p.checks.failed]), [
    [1, false, "claude/first-board", "c1", "MERGEABLE", "success", []],
    [2, true, "claude/first-board", "c2", "UNKNOWN", "pending", []],
    [3, false, "other", "c3", "CONFLICTING", "none", []],
  ]);
  assert.deepEqual(state.named, [
    { number: 20, state: "MERGED", url: "https://github.com/Ming-Research/wf-board/pull/20", mergedAt: "2026-10-16T01:02:03Z" },
    { number: 21, state: "OPEN", url: "https://github.com/Ming-Research/wf-board/pull/21" },
  ], "a PR number that does not exist is left out");
});

test("a branch that does not exist gives no main line; a bad answer is an error", () => {
  const empty = { main: null, pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } };
  assert.equal(parseResponse("a/b", answer(empty)).main, undefined);
  assert.throws(() => parseResponse("a/b", "<html>"), /not JSON/);
  assert.throws(() => parseResponse("a/b", JSON.stringify({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository" }] })), /Could not resolve to a Repository/);
  assert.throws(() => parseResponse("a/b", answer({ main: null })), /unexpected shape/);
  assert.match(queryText(true, []), /oid messageHeadline/, "the query asks for the main line's newest commit message line");
});

const checksOf = (state: string, ...nodes: unknown[]) => summarize(rollup(state, ...nodes) as Parameters<typeof summarize>[0]);
const status = (context: string, state: string) => ({ __typename: "StatusContext", context, state });

test("a cancelled run is neither red nor green, GitHub's roll-up state is not what is read, and no check is not green", () => {
  // GitHub's roll-up says FAILURE for a run a newer push cancelled; the commit's other checks passed.
  assert.deepEqual(checksOf("FAILURE", run("test", "SUCCESS"), run("e2e", "CANCELLED"), run("e2e", "SUCCESS")), { state: "success", failed: [] }, "the cancelled run was replaced by another of its name");
  assert.deepEqual(checksOf("FAILURE", run("test", "SUCCESS"), run("test", "CANCELLED")), { state: "success", failed: [] });
  assert.deepEqual(checksOf("FAILURE", run("test", "FAILURE"), run("e2e", "CANCELLED"), run("e2e", "SUCCESS")), { state: "failure", failed: ["test"] }, "a failure beside a cancelled run is still red");
  assert.deepEqual(checksOf("FAILURE", run("test", "CANCELLED"), run("e2e", null, "IN_PROGRESS")), { state: "pending", failed: [] });
  // A name that only has a cancelled run has not run: pending, so a green neighbour does not make the commit green.
  assert.deepEqual(checksOf("FAILURE", run("test", "CANCELLED"), run("e2e", "SUCCESS")), { state: "pending", failed: [] });
  assert.deepEqual(checksOf("FAILURE", run("test", "CANCELLED"), run("e2e", "CANCELLED")), { state: "pending", failed: [] }, "nothing ran yet");
  // A job run again on the same commit: only its latest attempt counts, in either order in the answer.
  const first = { at: "2026-10-16T10:00:00Z" }, again = { at: "2026-10-16T10:05:00Z" };
  assert.deepEqual(checksOf("FAILURE", run("test", "FAILURE", "COMPLETED", first), run("test", "SUCCESS", "COMPLETED", again)), { state: "success", failed: [] }, "red, then run again and green");
  assert.deepEqual(checksOf("FAILURE", run("test", "SUCCESS", "COMPLETED", again), run("test", "FAILURE", "COMPLETED", first)), { state: "success", failed: [] }, "the order of the answer does not matter");
  assert.deepEqual(checksOf("SUCCESS", run("test", "SUCCESS", "COMPLETED", first), run("test", "FAILURE", "COMPLETED", again)), { state: "failure", failed: ["test"] }, "green, then run again and red");
  assert.deepEqual(checksOf("FAILURE", run("test", "FAILURE", "COMPLETED", first), run("test", null, "QUEUED")), { state: "pending", failed: [] }, "the rerun is queued, not started");
  assert.deepEqual(checksOf("FAILURE", run("test", "FAILURE", "COMPLETED", first), run("test", null, "IN_PROGRESS", again)), { state: "pending", failed: [] }, "the rerun is running");
  assert.deepEqual(checksOf("FAILURE", run("test", "FAILURE", "COMPLETED", again), run("test", null, "IN_PROGRESS", first)), { state: "failure", failed: ["test"] }, "a run that started earlier and still goes on does not hide a later red");
  assert.deepEqual(checksOf("FAILURE", run("test", "FAILURE", "COMPLETED", first), run("test", "SUCCESS", "COMPLETED", first)), { state: "failure", failed: ["test"] }, "no telling which is later: the worse one counts");
  // Rounds of checks on one commit (the push round, the pull request round that tests the branch merged with its target) count each by itself: a red in either is a red, whichever started later.
  const push = { suite: "push" }, pull = { suite: "pull" };
  assert.deepEqual(checksOf("FAILURE", run("test", "FAILURE", "COMPLETED", { ...push, at: first.at }), run("test", "SUCCESS", "COMPLETED", { ...pull, at: again.at })), { state: "failure", failed: ["test"] }, "red in the earlier round, green in the later");
  assert.deepEqual(checksOf("FAILURE", run("test", "SUCCESS", "COMPLETED", { ...push, at: first.at }), run("test", "FAILURE", "COMPLETED", { ...pull, at: again.at })), { state: "failure", failed: ["test"] }, "green in the earlier round, red in the later");
  assert.deepEqual(checksOf("FAILURE", run("test", "FAILURE", "COMPLETED", { ...push, at: first.at }), run("test", "SKIPPED", "COMPLETED", { ...pull, at: again.at }), run("lint", "SUCCESS", "COMPLETED", pull)), { state: "failure", failed: ["test"] }, "a job one round skips does not hide the other round's red");
  // A rerun in one round replaces only that round's red.
  assert.deepEqual(checksOf("FAILURE", run("test", "FAILURE", "COMPLETED", { ...push, at: first.at }), run("test", "SUCCESS", "COMPLETED", { ...push, at: again.at }), run("test", "SUCCESS", "COMPLETED", pull)), { state: "success", failed: [] });
  assert.deepEqual(checksOf("FAILURE", run("test", "FAILURE", "COMPLETED", { ...push, at: first.at }), run("test", "SUCCESS", "COMPLETED", { ...push, at: again.at }), run("test", "FAILURE", "COMPLETED", pull)), { state: "failure", failed: ["test"] });
  // A cancelled run of a check that was run again in its round says nothing; one that is all there is in its round leaves the check pending.
  assert.deepEqual(checksOf("FAILURE", run("test", "CANCELLED", "COMPLETED", first), run("test", "SUCCESS", "COMPLETED", again)), { state: "success", failed: [] });
  assert.deepEqual(checksOf("FAILURE", run("test", "CANCELLED", "COMPLETED", { ...push, at: first.at }), run("test", "SUCCESS", "COMPLETED", { ...pull, at: again.at })), { state: "pending", failed: [] }, "cancelled in one round does not count as run in the other");
  // Without any check there is nothing to call green; GitHub reports no roll-up at all.
  assert.deepEqual(summarize(null), { state: "none", failed: [] });
  assert.deepEqual(checksOf("SUCCESS"), { state: "none", failed: [] }, "a roll-up that lists no check");
  // Skipped and neutral runs are no failure and no pass; a status from outside Actions counts; unknown values are not trusted.
  assert.deepEqual(checksOf("SUCCESS", run("gate", "SKIPPED"), run("lint", "NEUTRAL"), status("ci/x", "SUCCESS")), { state: "success", failed: [] });
  assert.deepEqual(checksOf("SUCCESS", run("gate", "SKIPPED"), run("test", "SUCCESS")), { state: "success", failed: [] });
  assert.deepEqual(checksOf("SUCCESS", run("gate", "SKIPPED"), run("lint", "NEUTRAL")), { state: "none", failed: [] }, "only gates that ran nothing is not green");
  assert.deepEqual(checksOf("SUCCESS", run("gate", "SKIPPED"), run("test", null, "IN_PROGRESS")), { state: "pending", failed: [] });
  assert.deepEqual(checksOf("SUCCESS", run("gate", "SKIPPED"), run("test", "FAILURE")), { state: "failure", failed: ["test"] });
  assert.deepEqual(checksOf("SUCCESS", run("test", "SUCCESS"), status("ci/x", "PENDING")), { state: "pending", failed: [] });
  assert.deepEqual(checksOf("SUCCESS", run("test", "SUCCESS"), run("odd", "SOMETHING_NEW")), { state: "failure", failed: ["odd"] }, "an unknown conclusion is not a pass");
  assert.deepEqual(checksOf("SUCCESS", run("test", "SUCCESS"), run("odd", null, "SOMETHING_NEW")), { state: "pending", failed: [] }, "an unknown status is not finished");
  assert.deepEqual(checksOf("SUCCESS", run("test", "ACTION_REQUIRED"), run("e2e", "STARTUP_FAILURE")), { state: "failure", failed: ["test", "e2e"] });
  // More checks than one answer holds: what is missing may fail, so it is not green; a failure seen is still red.
  const more = (...nodes: unknown[]) => summarize({ contexts: { pageInfo: { hasNextPage: true }, nodes } } as Parameters<typeof summarize>[0]);
  assert.deepEqual(more(run("test", "SUCCESS")), { state: "pending", failed: [] });
  assert.deepEqual(more(run("test", "FAILURE")), { state: "failure", failed: ["test"] });
});

test("an answer for a PR with a cancelled run is read as green, not red; a PR without checks, as GitHub gives a PR with a merge conflict, is not green", () => {
  const text = (...nodes: object[]) => answer({ main: null, pullRequests: { pageInfo: { hasNextPage: false }, nodes } });
  const checks = (node: object) => parseResponse(WB, text(node)).pulls[0]!.checks;
  assert.equal(checks(prNode(23, {}, rollup("FAILURE", run("test", "SUCCESS"), run("e2e", "CANCELLED"), run("e2e", "SUCCESS")))).state, "success", "the roll-up says failure, the checks say green");
  assert.deepEqual(checks(prNode(23, {}, rollup("FAILURE", run("test", "FAILURE"), run("e2e", "CANCELLED")))), { state: "failure", failed: ["test"] });
  assert.equal(checks(prNode(23, {}, rollup("FAILURE", run("test", "CANCELLED"), run("e2e", "CANCELLED")))).state, "pending", "cancelled and not yet replaced: neither red nor green");
  assert.equal(checks(prNode(23, {}, null)).state, "none", "no check found is not green");
  assert.equal(checks(prNode(23, {}, rollup("SUCCESS", run("gate", "SKIPPED"), run("lint", "NEUTRAL")))).state, "none", "only skipped gates (the push checks not there yet) is not green");
  // A PR with a merge conflict gets no pull_request run; what is left on its newest commit (a push run, or nothing) says nothing red.
  assert.equal(checks(prNode(23, { mergeable: "CONFLICTING" }, rollup("SUCCESS", run("test", "SUCCESS")))).state, "success");
  assert.equal(checks(prNode(23, { mergeable: "CONFLICTING" }, null)).state, "none");
});

test("the query names the main line by branch or by default, and one alias per PR number", () => {
  const withBranch = queryText(true, [23, 7]), withoutBranch = queryText(false, []);
  assert.match(withBranch, /\$ref: String!/); assert.match(withBranch, /main: ref\(qualifiedName: \$ref\)/);
  assert.match(withBranch, /p23: pullRequest\(number: 23\)/); assert.match(withBranch, /p7: pullRequest\(number: 7\)/);
  assert.match(withoutBranch, /main: defaultBranchRef/); assert.doesNotMatch(withoutBranch, /\$ref/);
  assert.throws(() => queryText(false, [1.5]), /positive integer/);
  assert.throws(() => queryText(false, [0]), /positive integer/);
});

test("gh is asked for the repository by owner and name as strings, with the branch as a full ref", async () => {
  const calls: string[][] = [], text = answer({ main: null, pullRequests: { pageInfo: { hasNextPage: false }, nodes: [prNode(5)] } });
  const gh: Gh = async args => { calls.push(args); return text; };
  const state = await ghSource(gh).query("Ming-Research/wf-board", { branch: "claude/first-board", numbers: [5] });
  assert.equal(state.repo, "Ming-Research/wf-board"); assert.equal(state.pulls[0]!.number, 5);
  const args = calls[0]!;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  for (const expected of ["owner=Ming-Research", "name=wf-board", "ref=refs/heads/claude/first-board"]) assert.equal(args[args.indexOf(expected) - 1], "-f", `${expected} goes as a string (-f)`);
  await ghSource(gh).query("mbbill/agents_config", { numbers: [] });
  assert.ok(!calls[1]!.some(a => a.startsWith("ref=")), "no branch, no ref");
  await assert.rejects(ghSource(gh).query("nonsense", { numbers: [] }), /expected Owner\/Name/);
});

test("gh exits with an error when the answer holds a GraphQL error; what it printed is still read, and a failure that printed nothing is reported", async () => {
  const text = answer({ main: null, pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] }, p99: null });
  const partial: Gh = async () => { throw Object.assign(new Error("exit 1"), { stdout: text }); };
  assert.deepEqual((await ghSource(partial).query("a/b", { numbers: [99] })).named, []);
  const silent: Gh = async () => { throw Object.assign(new Error("gh: command not found"), { stdout: "" }); };
  await assert.rejects(ghSource(silent).query("a/b", { numbers: [] }), /a\/b: gh failed: gh: command not found/);
});

test("the checks on one commit are asked for by its id and read as a PR's are; a commit GitHub does not know, a bad id and a gh that fails are errors", async () => {
  const sha = "a".repeat(40), calls: string[][] = [];
  const text = (object: unknown) => JSON.stringify({ data: { repository: { object } } });
  const gh = (reply: string): Gh => async args => { calls.push(args); return reply; };
  const checksOn = (rollupOrNull: unknown) => ghCommitChecks(gh(text({ oid: sha, statusCheckRollup: rollupOrNull })))("Ming-Research/wf-board", sha);
  assert.deepEqual(await checksOn(rollup("FAILURE", run("test", "SUCCESS"), run("e2e", "FAILURE"))), { state: "failure", failed: ["e2e"] });
  const args = calls[0]!;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  for (const expected of ["owner=Ming-Research", "name=wf-board", `oid=${sha}`, `query=${COMMIT_CHECKS_QUERY}`]) assert.equal(args[args.indexOf(expected) - 1], "-f", `${expected} goes as a string (-f)`);
  assert.match(COMMIT_CHECKS_QUERY, /object\(oid: \$oid\) \{ \.\.\. on Commit \{ oid statusCheckRollup/);
  // The same reading as for a PR: a cancelled run that another replaced says nothing, a commit with no check is not green, a run not finished is pending.
  assert.equal((await checksOn(rollup("FAILURE", run("test", "SUCCESS"), run("e2e", "CANCELLED"), run("e2e", "SUCCESS")))).state, "success");
  assert.equal((await checksOn(null)).state, "none");
  assert.equal((await checksOn(rollup("PENDING", run("test", "SUCCESS"), run("e2e", null, "QUEUED")))).state, "pending");
  assert.equal((await checksOn({ contexts: { pageInfo: { hasNextPage: true }, nodes: [run("test", "SUCCESS")] } })).state, "pending", "checks beyond one answer may fail");
  // A commit GitHub has no object for is not "no checks yet": waiting for it would never end.
  await assert.rejects(ghCommitChecks(gh(text(null)))("a/b", sha), /a\/b: GitHub does not know the commit a{40}/);
  // The id goes into the request as a string and is checked first: anything but a full id never reaches gh.
  const before = calls.length;
  await assert.rejects(ghCommitChecks(gh(""))("a/b", "main"), /expected a full object id/);
  await assert.rejects(ghCommitChecks(gh(""))("nonsense", sha), /expected Owner\/Name/);
  assert.equal(calls.length, before);
  const silent: Gh = async () => { throw Object.assign(new Error("gh: command not found"), { stdout: "" }); };
  await assert.rejects(ghCommitChecks(silent)("a/b", sha), /a\/b: gh failed: gh: command not found/);
  const refused: Gh = async () => { throw Object.assign(new Error("exit 1"), { stdout: JSON.stringify({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository" }] }) }); };
  await assert.rejects(ghCommitChecks(refused)("a/b", sha), /Could not resolve to a Repository/);
  await assert.rejects(ghCommitChecks(gh("<html>"))("a/b", sha), /not JSON/);
});

// --- The board --------------------------------------------------------------------------------------------------------------------

const heads = {
  watch: "**问题**：x\n\n## 改动\n\n### Ming-Research/wf-board#23 Check cards\n\n- `src/rules.ts`: a check\n\n### wf-board#24 Follow-up\n\n## 参考：old\n\nMing-Research/wf-board#99",
  second: "**问题**：y\n\n## 改动\n\nMing-Research/wf-board#25, https://github.com/Ming-Research/wf-board/pull/26, #27 and wf-board PR #29, Ming-Research/wf-board#32\n\n- Whitefoot#5, Ming-Research/Whitefoot#6, mbbill/agents_config#2, Ming-Research/Other#1",
  gone: "## 改动\n\nMing-Research/wf-board#30",
  bold: "**问题**：z\n\n**改动**：\n\n[wf-board#40](https://github.com/Ming-Research/wf-board/pull/40)：a change\n- x\n\n**参考：表**\n\nwf-board#41",
};

async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-watch-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [
    { name: "wf-board", repo: "Ming-Research/wf-board", mainline: "claude/first-board" },
    { name: "Whitefoot", repo: "Ming-Research/Whitefoot" },
    { name: "Architect", repo: "mbbill/agents_config" },
    { name: "总管" },
  ] } });
  const op = ops(store), author = "wf-board";
  const accept = { id: "accept", accept: true as const, text: "验收通过", state: "todo" as const };
  await op.createItem({ ...asArchitect, key: "watch", group: author, title: "Watch it", head: heads.watch, accept: "验收通过" });
  await op.createItem({ ...asArchitect, key: "second", group: author, title: "Second", head: heads.second, accept: "验收通过" });
  await op.createItem({ ...asArchitect, key: "bold", group: author, title: "Bold", head: heads.bold, accept: "验收通过" });
  await op.createItem({ ...asArchitect, key: "gone", group: author, title: "Cancelled", head: heads.gone, accept: "验收通过" });
  await op.setStatus({ ...asArchitect, id: "gone", status: "cancelled", log: "not needed" });
  const card = (key: string, blocks?: string) => op.writeCard({ author, key, item: "watch", question: `${key}?`, confidence: { reason: "判断" }, options: [{ text: "是", detail: "是" }, { text: "否", detail: "否" }], ...(blocks ? { blocks } : {}) });
  await card("approval", "合入停着"); await card("stop", "发布停着"); await card("plain"); await card("settled", "旧的");
  await op.ruleCard({ author, key: "settled", choice: "A", ruling: "同意" });
  await op.setPlan({ author, id: "watch", rows: [
    { id: "impl", text: "实现", state: "done" },
    { card: "approval", after: ["impl"] },
    // The other cards that block or blocked have their rows too; the merge row does not follow them.
    { card: "stop", after: ["impl"] },
    { card: "settled", after: ["impl"] },
    { id: "merge", text: "合入 Ming-Research/wf-board#23", state: "todo", after: ["approval"] },
    { ...accept, after: ["impl"] },
  ] });
  return { dir, store, op, author };
}
const green: Checks = { state: "success", failed: [] };
const pull = (number: number, fields: Partial<PullState> = {}): PullState => ({ number, title: `PR ${number}`, url: `https://github.com/Ming-Research/wf-board/pull/${number}`, draft: false, createdAt: "2026-01-01T00:00:00Z", base: "claude/first-board", commit: `c${number}`, mergeable: "MERGEABLE", checks: green, ...fields });
// wf-board's project names its main line branch, so a good answer for it holds that branch.
const repoState = (repo: string, fields: Partial<RepoState> = {}): RepoState => ({ repo, ...(repo === "Ming-Research/wf-board" ? { main: { branch: "claude/first-board", commit: "m0", subject: "", checks: green } } : {}), pulls: [], truncated: false, named: [], ...fields });
const WB = "Ming-Research/wf-board";

test("the 改动 section is a ## heading with its subsections, or a bold 改动 line, up to the next heading, bold section name or 参考", () => {
  // The heading form: subsections stay inside, a heading of its level or above ends it.
  assert.equal(changesSection("a\n## 改动\nx\n### y\nz\n## 参考：q\nw"), "x\n### y\nz");
  assert.equal(changesSection("## 改动\nonly"), "only");
  assert.equal(changesSection("## 改动\nx\n**参考：表**\nw"), "x", "a bold 参考 ends it");
  assert.equal(changesSection("## 改动\nx\n参考：表\nw"), "x", "so does a plain 参考 line");
  assert.equal(changesSection("## 改动\nx\n**验证**\nw"), "x", "and a bold section name alone");
  assert.equal(changesSection("## 改动\n**注意**：x\ny"), "**注意**：x\ny", "bold text with words after it is no section name");
  // The bold form, with or without a colon, or with the text on the same line.
  assert.equal(changesSection("**做法**：a\n\n**改动**：\n\n[wf-board#24](u)：t\n- f\n\n**参考：表**\nw"), "\n[wf-board#24](u)：t\n- f\n");
  assert.equal(changesSection("**改动**\n- a\n## 参考\nb"), "- a");
  assert.equal(changesSection("**改动**：[wf-board#24](u) inline\n- b"), "[wf-board#24](u) inline\n- b");
  assert.equal(changesSection("**改动**\nx\n### s\ny"), "x", "a bold section ends at a heading of any level");
  // What is no 改动 section.
  assert.equal(changesSection("## 做法\nno changes here"), "");
  assert.equal(changesSection(undefined), "");
  assert.equal(changesSection("### 改动\nnot a section heading of this level"), "");
  assert.equal(changesSection("**改动正确的理由**：x\n改动：x\n**改动**说明"), "");
});

test("the watched PRs are those an open item's 改动 section names, however the repository is written, and only in configured repositories", async t => {
  const { store } = await fixture(t), s = store.snapshot(), watched = watchedPulls(s, rules(s));
  const named = [...watched.values()].map(w => `${w.pr.repo}#${w.pr.number}:${w.items.join("+")}`).sort();
  assert.deepEqual(named, [
    "Ming-Research/Whitefoot#5:second", "Ming-Research/Whitefoot#6:second", "Ming-Research/wf-board#23:watch", "Ming-Research/wf-board#24:watch",
    "Ming-Research/wf-board#25:second", "Ming-Research/wf-board#26:second", "Ming-Research/wf-board#29:second", "Ming-Research/wf-board#32:second", "Ming-Research/wf-board#40:bold", "mbbill/agents_config#2:second",
  ], "#99 and #41 are outside the section, #27 has no repository, Other is not configured, #30 is on a cancelled item; #40 is in a bold section");
});

test("a merge row is an open item's step that says 合入 and names a PR its item's 改动 section names too, and is neither done, dropped nor an acceptance step", async t => {
  const { store, op, author } = await fixture(t);
  await op.setPlan({ author, id: "second", rows: [
    { id: "a", text: "合入 Ming-Research/wf-board#25", state: "todo" },
    { id: "b", text: "合入 wf-board#26，部署", state: "doing" },
    { id: "c", text: "实现 Ming-Research/wf-board#27 的改动", state: "todo" },
    { id: "d", text: "合入 Ming-Research/wf-board#28", state: "done" },
    { id: "e", text: "合入 Ming-Research/wf-board#29", state: "dropped", reason: "不做了" },
    { id: "f", text: "合入 Ming-Research/wf-board#31 之后验收", state: "todo", accept: true },
    { id: "g", text: "合入 PR，部署到本机的看板服务", state: "todo" },
    // A row that waits for another PR names it too; that PR is not the item's own, so it is no merge row of it.
    { id: "h", text: "设计日志已写；等 Ming-Research/wf-board#74 合入后，并入最新主线，合入主线", state: "todo" },
    { id: "i", text: "合入 Ming-Research/wf-board#25 和 Ming-Research/wf-board#26", state: "todo" },
    { id: "j", text: "等 Ming-Research/wf-board#74 合入后合入 Ming-Research/wf-board#29", state: "todo" },
    { id: "k", text: "合入 Ming-Research/wf-board#74", state: "todo" },
  ] });
  const s = store.snapshot(), merges = mergeRows(s, rules(s));
  assert.deepEqual(merges.map(m => `${m.item}/${m.step.id}:${m.prs.map(p => p.number).join("+")}`).sort(), [
    "second/a:25", "second/b:26", "second/i:25+26", "second/j:29", "watch/merge:23",
  ], "#74 is on no 改动 section: h and k are no merge rows, and j is the merge row of #29 only");
});

// --- What to tell ------------------------------------------------------------------------------------------------------------------

test("a red main line is told with the item that delivers its newest commit; no PR is told, red, draft, conflicting, named or not", async t => {
  const { store } = await fixture(t), s = store.snapshot();
  const states = [repoState(WB, {
    main: { branch: "claude/first-board", commit: "m1", subject: "Merge pull request #23 from Ming-Research/watch", checks: { state: "failure", failed: ["e2e"] } },
    pulls: [
      pull(23), pull(24, { draft: true }), pull(25, { checks: { state: "failure", failed: ["test"] } }), pull(26, { mergeable: "CONFLICTING" }),
      pull(27), pull(29, { checks: { state: "pending", failed: [] } }), pull(32, { checks: { state: "none", failed: [] } }), pull(99), pull(100, { draft: true }),
      pull(101, { checks: { state: "failure", failed: ["test"] } }), pull(31, { draft: true, checks: { state: "failure", failed: ["test"] } }),
    ],
  }), repoState("Ming-Research/Whitefoot", { main: { branch: "main", commit: "w1", subject: "Add a thing", checks: green }, pulls: [pull(5, { base: "main" })] })];
  const pushes = decide(s, states);
  assert.deepEqual(pushes.map(p => [p.event, p.fields.branch]), [["main-red", "claude/first-board"]], "a red PR, named (#25) or not (#101), and an unnamed one (#99, #100) are told to no one: an engineer watches its own PR's checks and the architect's patrol finds the PR no item names");
  assert.deepEqual(pushes[0]!.fields, { repo: WB, project: "wf-board", branch: "claude/first-board", commit: "m1", failed: ["e2e"], url: `https://github.com/${WB}/commit/m1`, item: "watch", pr: 23 }, "the commit's subject names #23, which the item watch's 改动 section names");
  assert.deepEqual(pushes.map(p => p.key), [`main-red ${WB} claude/first-board m1`]);
});

test("a red main line names the item that delivers the pull request its newest commit names: a held one first, a done one too, none when the subject names none", async t => {
  const { store, op, author } = await fixture(t);
  const red = (subject: string) => repoState(WB, { main: { branch: "claude/first-board", commit: "m1", subject, checks: { state: "failure", failed: ["e2e"] } } });
  let subject = "Merge pull request #23 from Ming-Research/watch";
  const told = () => { const s = store.snapshot(); return decide(s, [red(subject)]).find(p => p.event === "main-red")!.fields; };
  assert.deepEqual([told().item, told().pr], ["watch", 23]);
  subject = "Add a thing (#25)";
  assert.deepEqual([told().item, told().pr], ["second", 25], "a squash commit names its pull request in parentheses");
  subject = "Merge pull request #99 from Ming-Research/nobody";
  assert.deepEqual([told().item, told().pr], [null, null], "no item names #99");
  subject = "Update the readme";
  assert.deepEqual([told().item, told().pr], [null, null], "a subject that names no pull request");
  // Two items name #25: the one a session holds is the one told, whatever their order.
  const bold = store.snapshot().items.bold!;
  await op.updateItem({ author, id: "bold", rev: bold.rev, head: `## 改动\n\nMing-Research/wf-board#25\n\n${bold.head}`, reason: "name the PR" });
  subject = "Add a thing (#25)";
  assert.equal(told().item, "second", "no session holds either: the first in the board's item order (second comes before bold)");
  await op.dispatchStart({ ...asArchitect, id: "bold", role: "工程师", level: 2, model: "Sonnet", agent: "bold-worker", agentId: "agent-bold" });
  assert.equal(told().item, "bold", "the item a session holds");
  // The item may be done already: its session stays until its dispatch is closed.
  await op.setPlan({ author, id: "bold", rows: [{ id: "accept", accept: true, text: "验收通过", state: "done" }] });
  assert.equal(rules(store.snapshot()).statusOf("bold"), "done");
  assert.equal(told().item, "bold");
});

test("a merge row is done when GitHub reports merged every PR that counts for it, and not before", async t => {
  const { store, op, author } = await fixture(t);
  await op.setPlan({ author, id: "second", rows: [
    { id: "a", text: "合入 Ming-Research/wf-board#25", state: "todo" },
    { id: "i", text: "合入 Ming-Research/wf-board#25 和 Ming-Research/wf-board#26", state: "todo" },
    { id: "j", text: "等 Ming-Research/wf-board#74 合入后合入 Ming-Research/wf-board#29", state: "todo" },
    { id: "accept", accept: true, text: "验收通过", state: "todo" },
  ] });
  const s = store.snapshot(), r = rules(s), named = (...pulls: Array<[number, "MERGED" | "OPEN" | "CLOSED"]>) => [repoState(WB, { named: pulls.map(([number, state]) => ({ number, state, url: "u", ...(state === "MERGED" ? { mergedAt: `t${number}` } : {}) })) })];
  const done = (states: RepoState[]) => mergedRows(s, r, states).map(m => `${m.item}/${m.step.id}:${m.prs.map(p => `${p.number}@${p.mergedAt}`).join("+")}`).sort();
  assert.deepEqual(done(named([23, "MERGED"], [25, "CLOSED"], [26, "OPEN"], [29, "OPEN"], [74, "MERGED"])), ["watch/merge:23@t23"], "closed is not merged, and #74 merged finishes nothing");
  assert.deepEqual(done(named([25, "MERGED"], [26, "OPEN"], [29, "MERGED"])), ["second/a:25@t25", "second/j:29@t29"], "i waits for #26");
  assert.deepEqual(done(named([25, "MERGED"], [26, "MERGED"])), ["second/a:25@t25", "second/i:25@t25+26@t26"]);
  assert.deepEqual(done([]), [], "a repository that could not be asked finishes nothing");
});

test("a push is the same push again for the same commit only, and only a red main line is one", () => {
  const red = (commit: string, branch = "main") => ({ repo: "a/b", branch, commit });
  assert.equal(pushKey("main-red", red("x")), pushKey("main-red", { ...red("x"), failed: ["other"] }));
  assert.notEqual(pushKey("main-red", red("x")), pushKey("main-red", red("y")));
  assert.notEqual(pushKey("main-red", red("x")), pushKey("main-red", red("x", "release")));
  for (const event of ["pr-red", "pr-orphan", "pr-ready", "note"]) assert.equal(pushKey(event, { repo: "a/b", number: 1, commit: "x" }), undefined, `${event} is no push of the watch`);
});

// --- The watch ---------------------------------------------------------------------------------------------------------------------

function fake(states: Record<string, RepoState | Error> = {}) {
  const calls: Array<{ repo: string; branch?: string; numbers: number[] }> = [];
  const source: GithubSource = { async query(repo, options) { calls.push({ repo, ...options }); const state = states[repo]; if (state instanceof Error) throw state; return state ?? repoState(repo); } };
  return { source, calls, states };
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { const log = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = log; } };

test("a look queries every configured repository once, with its main line branch and the PRs its merge rows name", async t => {
  const { store, op } = await fixture(t), github = fake();
  await new GithubWatch({ store, ops: op, wake: new Wake(), github: github.source }).poll();
  assert.deepEqual(github.calls, [
    { repo: WB, branch: "claude/first-board", numbers: [23] },
    { repo: "Ming-Research/Whitefoot", numbers: [] },
    { repo: "mbbill/agents_config", numbers: [] },
  ], "a project without a repo is not asked, and without a mainline the default branch is read");
});

test("no PR is told at any look: red, draft, pending, green or named by no item; the checks of one are its engineer's", async t => {
  const { store, op } = await fixture(t), red = { state: "failure" as const, failed: ["test"] };
  const github = fake({ [WB]: repoState(WB, { pulls: [pull(23, { commit: "c23", checks: red }), pull(24, { draft: true, checks: red }), pull(25, { checks: { state: "pending", failed: [] } }), pull(26), pull(99, { checks: red }), pull(100, { draft: true })] }) });
  const wake = new Wake(), watch = new GithubWatch({ store, ops: op, wake, github: github.source, now: () => Date.parse("2026-10-16T12:00:00Z") });
  await watch.poll(); await watch.poll();
  github.states[WB] = repoState(WB, { pulls: [pull(23, { commit: "c23b", checks: red })] });
  await watch.poll();
  assert.deepEqual(wake.kept(), [], "nothing for a red PR a 改动 section names (#23), for a draft, for pending checks, for a green one, or for a PR no item names (#99, #100), however many looks and commits");
});

test("a red main line is told to the architect once per commit: not at the next look, not after a restart, again for a new commit", async t => {
  const { store, op } = await fixture(t), red = (commit: string) => repoState(WB, { main: { branch: "claude/first-board", commit, subject: "", checks: { state: "failure", failed: ["test"] } } });
  const github = fake({ [WB]: red("m1") }), wake = new Wake(), watch = new GithubWatch({ store, ops: op, wake, github: github.source });
  const told = () => wake.agent(ARCHITECT_SESSION).since(0).frames.map(f => [f.event, f.commit]);
  await watch.poll(); await watch.poll();
  assert.deepEqual(told(), [["main-red", "m1"]], "no item delivers the commit and nothing holds it: the architect's stream");
  await new GithubWatch({ store, ops: op, wake, github: github.source }).poll();
  assert.equal(told().length, 1, "a watch started over the same kept events knows what was told");
  github.states[WB] = red("m2"); await watch.poll();
  assert.deepEqual(told(), [["main-red", "m1"], ["main-red", "m2"]]);
});

test("a red main line goes to the session holding the item that delivered it, and to the architect when none holds it", async t => {
  const { store, op } = await fixture(t);
  const github = fake({ [WB]: repoState(WB, { main: { branch: "claude/first-board", commit: "m1", subject: "Merge pull request #23 from Ming-Research/watch", checks: { state: "failure", failed: ["test"] } } }) });
  const wake = new Wake(), watch = new GithubWatch({ store, ops: op, wake, github: github.source });
  wake.routeBy(item => item === "watch" ? "watch-worker" : undefined);
  await watch.poll();
  assert.deepEqual(wake.agent("watch-worker").since(0).frames.map(f => [f.event, f.item, f.commit]), [["main-red", "watch", "m1"]]);
  assert.deepEqual(wake.agent(ARCHITECT_SESSION).since(0).frames, [], "the holder has it, so the architect does not");
  github.states[WB] = repoState(WB, { main: { branch: "claude/first-board", commit: "m2", subject: "Update the readme", checks: { state: "failure", failed: ["test"] } } });
  await watch.poll();
  assert.deepEqual(wake.agent(ARCHITECT_SESSION).since(0).frames.map(f => [f.event, f.item, f.commit]), [["main-red", null, "m2"]], "a commit no item delivered goes to the architect");
});

test("a merged PR marks its merge row done, writes the item's log under the board's own session, and does not write again", async t => {
  const { store, op } = await fixture(t), github = fake({ [WB]: repoState(WB, { named: [{ number: 23, state: "MERGED", url: "u", mergedAt: "2026-10-16T01:00:00Z" }] }) });
  const watch = new GithubWatch({ store, ops: op, wake: new Wake(), github: github.source });
  const before = store.snapshot().head, commits = (await store.log()).length;
  await watch.poll();
  const s = store.snapshot(), row = s.items.watch!.plan.find(p => p.id === "merge") as { state: string; doneAt?: string; text: string; after?: string[] };
  assert.equal(row.state, "done"); assert.ok(row.doneAt, "dated");
  assert.equal(row.text, "合入 Ming-Research/wf-board#23", "its text and place are kept");
  assert.deepEqual(row.after, ["approval"]);
  assert.match(s.items.watch!.log.at(-1)!.text, /^Ming-Research\/wf-board#23（2026-10-16T01:00:00Z） 已在 GitHub 合入，看板把合入行「合入 Ming-Research\/wf-board#23」标成完成。$/);
  assert.equal(s.items.watch!.log.at(-1)!.by, "wf-board");
  const log = await store.log();
  assert.equal(log.length, commits + 1, "the row and its log entry are one commit");
  assert.deepEqual([log[0]!.session, log[0]!.files], ["看板", ["items/watch.yaml"]]);
  const after = s.head;
  await watch.poll();
  assert.equal(store.snapshot().head, after, "the row is no longer open: nothing is written again");
  assert.notEqual(before, after);
  assert.deepEqual(s.items.second!.plan.map(p => "state" in p && p.state), ["todo"], "other items are untouched");
});

test("a merged PR whose row cannot be written is tried again at the next look", async t => {
  const { store, op } = await fixture(t), github = fake({ [WB]: repoState(WB, { named: [{ number: 23, state: "MERGED", url: "u" }] }) });
  let fail = true;
  const flaky = { ...op, markMerged: (a: Parameters<typeof op.markMerged>[0]) => fail ? Promise.reject(new Error("busy")) : op.markMerged(a) };
  const watch = new GithubWatch({ store, ops: flaky, wake: new Wake(), github: github.source });
  await quiet(() => watch.poll());
  assert.equal((store.snapshot().items.watch!.plan.find(p => p.id === "merge") as { state: string }).state, "todo");
  fail = false; await watch.poll();
  assert.equal((store.snapshot().items.watch!.plan.find(p => p.id === "merge") as { state: string }).state, "done");
});

test("a repository that fails is reported in the status and the others still go on; the report clears with the next good look", async t => {
  const { store, op } = await fixture(t), github = fake({ [WB]: new Error("gh failed"), "Ming-Research/Whitefoot": repoState("Ming-Research/Whitefoot", { main: { branch: "main", commit: "w1", subject: "", checks: { state: "failure", failed: ["test"] } } }) });
  const wake = new Wake(), watch = new GithubWatch({ store, ops: op, wake, github: github.source, now: () => Date.parse("2026-10-16T02:00:00Z") });
  await quiet(() => watch.poll());
  assert.deepEqual(watch.status(), { polledAt: "2026-10-16T02:00:00.000Z", problems: { [WB]: "gh failed" } });
  assert.deepEqual(wake.agent(ARCHITECT_SESSION).since(0).frames.map(f => f.repo), ["Ming-Research/Whitefoot"], "the other repository was read");
  github.states[WB] = repoState(WB, { truncated: true });
  await quiet(() => watch.poll());
  assert.match(watch.status().problems[WB]!, /more open PRs than one look reads/);
  github.states[WB] = repoState(WB, { main: { branch: "claude/first-board", commit: "m", subject: "", checks: green } });
  await watch.poll();
  assert.deepEqual(watch.status().problems, {});
  github.states[WB] = repoState(WB, { main: undefined });
  await quiet(() => watch.poll());
  assert.deepEqual(watch.status().problems, { [WB]: "main line branch claude/first-board not found" }, "a configured main line that GitHub does not have is a problem, not silence");
});

test("start looks at once and then at every interval, and stop ends it", async t => {
  const { store, op } = await fixture(t), github = fake();
  const watch = new GithubWatch({ store, ops: op, wake: new Wake(), github: github.source, everyMs: 20 });
  const polls = () => github.calls.filter(c => c.repo === WB).length;
  watch.start();
  for (let i = 0; i < 300 && polls() < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  watch.stop();
  assert.ok(polls() >= 3, "an immediate look and then timed ones");
  await new Promise(resolve => setTimeout(resolve, 60));
  const settled = polls();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(polls(), settled, "no look after stop");
});

// The time of the last look is kept in a file, so restarts do not add looks to the one in five minutes.
async function stateDir(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-watch-state-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return join(dir, "state", "github-watch.json");
}

test("a look records its time, and a watch started over that file waits out the rest of the interval", async t => {
  const { store, op } = await fixture(t), stateFile = await stateDir(t), at = Date.parse("2026-10-16T02:00:00Z"), every = 300_000;
  const watch = (now: number, file = stateFile) => new GithubWatch({ store, ops: op, wake: new Wake(), github: fake().source, now: () => now, everyMs: every, stateFile: file });
  assert.equal(watch(at).nextDelayMs(), 0, "no look known: look at once");
  await watch(at).poll();
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), { polledAt: "2026-10-16T02:00:00.000Z" }, "the time of the look and nothing else");
  assert.equal(watch(at + 120_000).nextDelayMs(), 180_000, "two minutes after the last look, three are left");
  assert.equal(watch(at + every).nextDelayMs(), 0);
  assert.equal(watch(at + 2 * every).nextDelayMs(), 0, "overdue: at once");
  assert.equal(watch(at - 60_000).nextDelayMs(), every, "a clock that went back waits one interval, not more");
  assert.equal(watch(at + 120_000).status().polledAt, "2026-10-16T02:00:00.000Z");
  // A file of the older kind, which also kept the repositories looked at and the open PRs of the first look, is read for the time alone.
  await writeFile(stateFile, JSON.stringify({ polledAt: "2026-10-16T02:00:00.000Z", looked: ["ming-research/wf-board"], baseline: [`pr-orphan ${WB}#90`] }));
  assert.equal(watch(at + 120_000).nextDelayMs(), 180_000, "the older file gives the time of the last look");
  await watch(at + every).poll();
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), { polledAt: "2026-10-16T02:05:00.000Z" }, "and the next look writes the time alone");
  await writeFile(stateFile, "not json");
  assert.equal(watch(at).nextDelayMs(), 0, "a file that cannot be read costs one early look");
  await writeFile(stateFile, JSON.stringify({ polledAt: "yesterday" }));
  assert.equal(watch(at).nextDelayMs(), 0);
});

test("start does not look before the interval since the last look has passed, and looks at once when it has", async t => {
  const { store, op } = await fixture(t), stateFile = await stateDir(t), github = fake();
  const watch = () => new GithubWatch({ store, ops: op, wake: new Wake(), github: github.source, everyMs: 10_000, stateFile });
  const polls = () => github.calls.filter(c => c.repo === WB).length;
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ polledAt: new Date().toISOString() }));
  const recent = watch(); recent.start();
  await new Promise(resolve => setTimeout(resolve, 150));
  recent.stop();
  assert.equal(polls(), 0, "a look just happened: a restart does not look again");
  await writeFile(stateFile, JSON.stringify({ polledAt: new Date(Date.now() - 60_000).toISOString() }));
  const overdue = watch(); overdue.start();
  for (let i = 0; i < 300 && polls() < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
  overdue.stop();
  assert.equal(polls(), 1, "the interval has passed: the first look is at once");
});

test("a merge row is marked done with its log in one commit, and only if it is still open, still counts these PRs, and all of them are merged", async t => {
  const { store, op, author } = await fixture(t);
  const row = () => store.snapshot().items.watch!.plan.find(p => p.id === "merge") as { state: string; text: string };
  const mark = (merged: Array<{ repo: string; number: number }> = [{ repo: WB, number: 23 }]) => op.markMerged({ author, session: "看板", id: "watch", row: "merge", merged, log: "合入了" });
  const head = () => store.snapshot().head;
  // Rows that changed since the watch read them are left as written.
  const before = head();
  await mark([{ repo: WB, number: 24 }]);
  assert.equal(head(), before, "a PR that is not the row's: nothing written");
  await op.setPlan({ author, id: "watch", row: { id: "merge", text: "合入 Ming-Research/wf-board#23 和 Ming-Research/wf-board#24", state: "todo", after: ["approval"] } });
  const edited = head();
  await mark();
  assert.equal(head(), edited, "the row now counts #24 too, which is not merged: nothing written");
  await op.setPlan({ author, id: "watch", row: { id: "merge", text: "合入 Ming-Research/wf-board#23", state: "dropped", reason: "不做了", after: ["approval"] } });
  const dropped = head();
  await mark();
  assert.equal(head(), dropped, "a dropped row stays dropped");
  await op.setPlan({ author, id: "watch", row: { id: "merge", text: "合并 Ming-Research/wf-board#23", state: "todo", after: ["approval"] } });
  const reworded = head();
  await mark();
  assert.equal(head(), reworded, "a row that no longer says 合入 is no merge row");
  await op.setPlan({ author, id: "watch", remove: "merge" });
  const removed = head();
  await mark();
  assert.equal(head(), removed, "a removed row is not put back");
  assert.equal(store.snapshot().items.watch!.plan.some(p => p.id === "merge"), false);
  // The row as it is, done, and its log entry are one commit.
  await op.setPlan({ author, id: "watch", row: { id: "merge", text: "合入 Ming-Research/wf-board#23", state: "doing", after: ["approval"] } });
  const commits = (await store.log()).length;
  await mark();
  assert.equal(row().state, "done");
  assert.equal(row().text, "合入 Ming-Research/wf-board#23");
  const log = await store.log();
  assert.equal(log.length, commits + 1);
  assert.deepEqual([log[0]!.session, log[0]!.files], ["看板", ["items/watch.yaml"]]);
  assert.equal(store.snapshot().items.watch!.log.at(-1)!.text, "合入了");
  const done = head();
  await mark();
  assert.equal(head(), done, "a done row is not written again");
  // Another project's item is not the board's to write as that project's author.
  await assert.rejects(op.markMerged({ author: "Whitefoot", session: "看板", id: "watch", row: "merge", merged: [{ repo: WB, number: 23 }], log: "x" }), /belongs to project wf-board/);
});

test("the watch runs inside the server: a red main line reaches the architect's stream and /health reports the look", async t => {
  const wake = new Wake(), github = fake();
  let watch: GithubWatch | undefined;
  const { api, url } = await server(t, { wake, watch: fx => (watch = new GithubWatch({ store: fx.store, ops: fx.op, wake, github: github.source })) });
  const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(done(), "timed out"); };
  await until(() => watch!.status().polledAt !== undefined);
  github.states["Ming-Research/Whitefoot"] = repoState("Ming-Research/Whitefoot", { main: { branch: "main", commit: "w1", subject: "", checks: { state: "failure", failed: ["test"] } } });
  const socket = await agentSocket(t, url, ARCHITECT_SESSION);
  await watch!.poll(); await socket.sync();
  assert.deepEqual(socket.events().map(f => [f.event, f.repo, f.branch, f.commit]), [["main-red", "Ming-Research/Whitefoot", "main", "w1"]]);
  const health = await api("/health", undefined, "GET");
  assert.equal(health.status, 200);
  assert.ok((health.data as { github: { polledAt: string } }).github.polledAt, "the look is shown");
});
