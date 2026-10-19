// The time gate of the full CI and the status it writes (scripts/ci-time-gate.ts; docs/design.md, section 11, The time gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANCEL_GRACE_MS, FEW_OPEN, LIMIT_SECONDS, LOOK_MS, SHARD_RATIO, evaluate, shardTable, statusOf, verdictOf, waitForJobs } from "../scripts/ci-time-gate.ts";
import type { Job } from "../scripts/ci-time-gate.ts";

const started = "2026-10-17T10:00:00Z";
/** An ISO time `s` seconds after the run started. */
const at = (s: number) => new Date(Date.parse(started) + s * 1000).toISOString().replace(".000Z", "Z");
/** A job that started `from` and ended `to` seconds after the run started. */
const job = (name: string, from: number, to: number, steps: Job["steps"] = []): Job => ({ name, conclusion: "success", started_at: at(from), completed_at: at(to), steps });
/** A test shard whose `tests` step took `s` seconds, after 12 seconds of setup. */
const shard = (n: number, s: number) => job(`test shard ${n}`, 3, 15 + s, [{ name: "tests", started_at: at(15), completed_at: at(15 + s) }]);
const evenShards = (s: number) => Array.from({ length: 8 }, (_, i) => shard(i + 1, s));

test("the total is red above 60 seconds and yellow above 50, and exactly on a limit is the milder one", () => {
  assert.deepEqual([0, 49, 50].map(verdictOf), ["ok", "ok", "ok"]);
  assert.deepEqual([51, 60].map(verdictOf), ["yellow", "yellow"]);
  assert.deepEqual([61, 700].map(verdictOf), ["red", "red"]);
  assert.deepEqual(LIMIT_SECONDS, { yellow: 50, red: 60 });
});

test("the total runs from the start of the run to the moment of the status, not the sum of the jobs, and the last job's end is named", () => {
  const jobs = [job("check", 2, 20), job("no-tmp-workflow", 2, 8), job("test shard 1", 3, 31), job("e2e", 4, 71)];
  const result = evaluate(started, jobs, { enforce: true, now: at(73) });
  assert.equal(result.total, 73);
  assert.equal(result.verdict, "red");
  assert.match(result.markdown, /\*\*73 s\*\* from the start of the run to the status \(the last job, e2e, ended at 71 s\): over the limit/);
  assert.match(result.markdown, /\| e2e \| 4 \| 67 \| 71 \|/);
  assert.match(result.markdown, /\| check \| 2 \| 18 \| 20 \|/);
});

test("the wait for the status counts: a run whose last job ended inside the limit is over it when the status comes late", () => {
  const jobs = [job("test shard 1", 3, 58)];
  assert.equal(evaluate(started, jobs, { enforce: true, now: at(59) }).verdict, "yellow");
  assert.equal(evaluate(started, jobs, { enforce: true, now: at(61) }).verdict, "red");
  // A clock that is behind the jobs' does not take seconds off the total.
  assert.equal(evaluate(started, jobs, { enforce: true, now: at(40) }).total, 58);
});

test("the job that is reading does not count, and neither does a job that never started", () => {
  const jobs = [job("check", 2, 20), { ...job("result", 80, 90) }, { name: "start", conclusion: "skipped", started_at: null, completed_at: null }, { name: "e2e", conclusion: null, started_at: at(5), completed_at: null }];
  const result = evaluate(started, jobs, { enforce: true, now: at(22) });
  assert.equal(result.total, 22);
  assert.equal(result.verdict, "ok");
  assert.doesNotMatch(result.markdown, /\| result \|/);
});

test("a red total fails the step only when the gate is enforced, a yellow one never", () => {
  const red = [job("test shard 1", 3, 75)];
  const yellow = [job("test shard 1", 3, 55)];
  assert.equal(evaluate(started, red, { enforce: false, now: at(76) }).fail, false);
  assert.equal(evaluate(started, red, { enforce: true, now: at(76) }).fail, true);
  assert.equal(evaluate(started, yellow, { enforce: true, now: at(56) }).fail, false);
  assert.equal(evaluate(started, yellow, { enforce: true, now: at(56) }).verdict, "yellow");
  assert.match(evaluate(started, red, { enforce: false, now: at(76) }).markdown, /over the limit .*Report only, not enforced/);
  assert.match(evaluate(started, red, { enforce: true, now: at(76) }).markdown, /over the limit .*Enforced\./);
});

test("shards of one size name no slow shard, and one shard over 1.5 times the mean of the others is named", () => {
  assert.deepEqual(shardTable(evenShards(20)).filter(s => s.slow), []);
  const jobs = evenShards(20);
  jobs[2] = shard(3, 31);
  const slow = shardTable(jobs).filter(s => s.slow);
  assert.deepEqual(slow.map(s => [s.name, s.step, s.others]), [["test shard 3", 31, 20]]);
  const text = evaluate(started, jobs, { enforce: false, now: at(50) }).markdown;
  assert.match(text, /test shard 3 took 31 s, over 1\.5 times the mean of the other shards \(20\.0 s\)/);
  assert.match(text, /\| test shard 3 \| 31 \| 20\.0 \|/);
  assert.equal(SHARD_RATIO, 1.5);
});

test("a shard at exactly 1.5 times the mean of the others is not slow, and the mean leaves the shard itself out", () => {
  const jobs = evenShards(20);
  jobs[0] = shard(1, 30);
  assert.deepEqual(shardTable(jobs).filter(s => s.slow), []);
  // Against the mean of all eight (21.5 s) 32 s is 1.49 times; against the other seven (20 s) it is 1.6 times.
  jobs[0] = shard(1, 32);
  assert.deepEqual(shardTable(jobs).filter(s => s.slow).map(s => s.name), ["test shard 1"]);
});

test("a job that is not a shard is left out of the shard table, as is a shard whose tests step has not finished", () => {
  const notShard = job("e2e", 4, 60, [{ name: "tests", started_at: at(10), completed_at: at(58) }]);
  const unfinished: Job = { name: "test shard 2", conclusion: null, started_at: at(3), completed_at: at(20), steps: [{ name: "tests", started_at: at(15), completed_at: null }] };
  const table = shardTable([notShard, unfinished, shard(1, 10), shard(3, 10)]);
  assert.deepEqual(table.map(s => s.name), ["test shard 1", "test shard 3"]);
});

test("shards are listed in numeric order and a lone shard has no others to be compared with", () => {
  const table = shardTable([shard(10, 5), shard(2, 5), shard(1, 5)]);
  assert.deepEqual(table.map(s => s.name), ["test shard 1", "test shard 2", "test shard 10"]);
  const lone = shardTable([shard(1, 99)]);
  assert.deepEqual(lone.map(s => [s.others, s.slow]), [[null, false]]);
});

test("the summary says so when no shard job is found, so a renamed job does not drop the table unnoticed", () => {
  const text = evaluate(started, [job("check", 2, 20)], { enforce: false, now: at(22) }).markdown;
  assert.match(text, /No test shard found/);
  assert.doesNotMatch(evaluate(started, evenShards(20), { enforce: false, now: at(40) }).markdown, /No test shard found/);
});

// ---- the wait for the other jobs and the status ----

const open = (name: string): Job => ({ name, status: "in_progress", conclusion: null, started_at: at(3), completed_at: null });
const ended = (name: string, conclusion = "success"): Job => ({ name, status: "completed", conclusion, started_at: at(3), completed_at: at(30) });
/** A `look` that answers the lists in turn (the last one again after that) and a `sleep` that only records how long it was asked to wait. */
function script(lists: Job[][]) {
  const waits: number[] = [];
  let looks = 0;
  return {
    waits,
    looks: () => looks,
    look: async () => lists[Math.min(looks++, lists.length - 1)]!,
    sleep: async (ms: number) => { waits.push(ms); },
  };
}

test("the wait returns at the first look at which every job but its own has ended, and the job itself is not waited for", async () => {
  const s = script([[open("result"), open("check"), open("test shard 1")], [open("result"), ended("check"), open("test shard 1")], [open("result"), ended("check"), ended("test shard 1")]]);
  const jobs = await waitForJobs(s.look, "result", s.sleep);
  assert.equal(s.looks(), 3);
  assert.deepEqual(jobs.map(j => j.status), ["in_progress", "completed", "completed"]);
  assert.equal(s.waits.length, 2);
});

test("the wait looks every 2 seconds while more than 4 jobs are open and every second when fewer are", async () => {
  const many = Array.from({ length: FEW_OPEN + 1 }, (_, i) => open(`test shard ${i}`));
  const few = Array.from({ length: FEW_OPEN }, (_, i) => open(`test shard ${i}`));
  const s = script([[open("result"), ...many], [open("result"), ...few], [open("result"), ...few.map(j => ended(j.name))]]);
  await waitForJobs(s.look, "result", s.sleep);
  assert.deepEqual(s.waits, [LOOK_MS.many, LOOK_MS.few]);
  assert.deepEqual(LOOK_MS, { many: 2000, few: 1000 });
});

test("a list with no other job is not an answer, so a run whose jobs are not listed yet is waited for", async () => {
  const s = script([[open("result")], [], [open("result"), ended("check")]]);
  const jobs = await waitForJobs(s.look, "result", s.sleep);
  assert.equal(s.looks(), 3);
  assert.deepEqual(jobs.map(j => j.name), ["result", "check"]);
});

test("a cancelled job is given a grace before the result stands, once, so a cancelled run ends this job first and a job that timed out does not hold it", async () => {
  const s = script([[open("result"), ended("check", "cancelled"), ended("test shard 1")]]);
  const jobs = await waitForJobs(s.look, "result", s.sleep);
  assert.deepEqual(s.waits, [CANCEL_GRACE_MS]);
  assert.equal(s.looks(), 2);
  assert.equal(jobs[1]!.conclusion, "cancelled");
  // Jobs that failed or were skipped get no grace.
  const plain = script([[open("result"), ended("check", "failure"), ended("test shard 1", "skipped")]]);
  await waitForJobs(plain.look, "result", plain.sleep);
  assert.deepEqual(plain.waits, []);
});

test("the status is success when every other job succeeded or was skipped, and says how many jobs and how long", () => {
  const jobs = [open("result"), ended("check"), ended("start", "skipped"), ended("test shard 1")];
  assert.deepEqual(statusOf(jobs, "result", { total: 48, fail: false }), { state: "success", description: "full CI success (3 jobs, 48 s)" });
});

test("the status is failure when a job did not succeed, naming up to four of them, whatever the gate says", () => {
  const jobs = [open("result"), ended("check", "failure"), ended("no-tmp-workflow", "cancelled"), ended("nkey counts", "failure"), ended("test shard 1")];
  const status = statusOf(jobs, "result", { total: 70, fail: true });
  assert.equal(status.state, "failure");
  assert.equal(status.description, "full CI failure (check, no-tmp-workflow, nkey counts not green)");
  const many = [open("result"), ...Array.from({ length: 6 }, (_, i) => ended(`test shard ${i + 1}`, "failure"))];
  assert.equal(statusOf(many, "result", { total: 40, fail: false }).description, "full CI failure (test shard 1, test shard 2, test shard 3, test shard 4 and 2 more not green)");
  // A job with no conclusion has not succeeded.
  assert.equal(statusOf([open("result"), { ...ended("check"), conclusion: null }], "result", { total: 40, fail: false }).state, "failure");
});

test("a red gate makes the status failure with the time in its description, and a description is cut at 140 characters", () => {
  const jobs = [open("result"), ended("check"), ended("test shard 1")];
  assert.deepEqual(statusOf(jobs, "result", { total: 63, fail: true }), { state: "failure", description: "full CI failure (time gate: 63 s)" });
  const long = [open("result"), ended("a".repeat(80), "failure"), ended("b".repeat(80), "failure")];
  assert.equal(statusOf(long, "result", { total: 40, fail: false }).description.length, 140);
});
