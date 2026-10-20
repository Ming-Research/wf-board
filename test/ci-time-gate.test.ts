// The time gate of the full CI and the status it writes (scripts/ci-time-gate.ts; docs/design.md, section 11, The time gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANCEL_GRACE_MS, FEW_OPEN, LIMIT_SECONDS, LOOK_MS, MARK_ALLOWANCE_SECONDS, SHARD_RATIO, evaluate, quickestWait, shardTable, statusOf, verdictOf, waitForJobs } from "../scripts/ci-time-gate.ts";
import type { Job } from "../scripts/ci-time-gate.ts";

const started = "2026-10-17T10:00:00Z";
/** An ISO time `s` seconds after the run started. */
const at = (s: number) => new Date(Date.parse(started) + s * 1000).toISOString().replace(".000Z", "Z");
/** A job that started `from` and ended `to` seconds after the run started, having waited `wait` seconds for a runner. */
const job = (name: string, from: number, to: number, steps: Job["steps"] = [], wait = 3): Job => ({ name, conclusion: "success", created_at: at(from - wait), started_at: at(from), completed_at: at(to), steps });
/** A job like `job` whose last step ended `lag` seconds before GitHub marked it complete (at `to`). */
const markedLate = (name: string, from: number, to: number, lag: number, wait = 3): Job => job(name, from, to, [{ name: "tests", started_at: at(from), completed_at: at(to - lag) }], wait);
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
  const result = evaluate(started, jobs, { mode: "enforce", now: at(73) });
  assert.equal(result.total, 73);
  assert.equal(result.verdict, "red");
  assert.match(result.markdown, /\*\*73 s\*\* from the start of the run to the status, without the wait for a runner and the late marking of jobs complete: over the limit/);
  assert.match(result.markdown, /The run took 73 s in all \(the last job, e2e, ended at 71 s\)/);
  assert.match(result.markdown, /\| e2e \| 3 \| 0 \| 67 \| 71 \|/);
  assert.match(result.markdown, /\| check \| 3 \| 0 \| 18 \| 20 \|/);
});

test("the wait for the status counts: a run whose last job ended inside the limit is over it when the status comes late", () => {
  const jobs = [job("test shard 1", 3, 58)];
  assert.equal(evaluate(started, jobs, { mode: "enforce", now: at(59) }).verdict, "yellow");
  assert.equal(evaluate(started, jobs, { mode: "enforce", now: at(61) }).verdict, "red");
  // A clock that is behind the jobs' does not take seconds off the total.
  assert.equal(evaluate(started, jobs, { mode: "enforce", now: at(40) }).total, 58);
});

test("the job that is reading does not count, and neither does a job that never started", () => {
  const jobs = [job("check", 2, 20), { ...job("result", 3, 90) }, { name: "start", conclusion: "skipped", created_at: at(0), started_at: null, completed_at: null }, { name: "e2e", conclusion: null, created_at: at(2), started_at: at(5), completed_at: null }];
  const result = evaluate(started, jobs, { mode: "enforce", now: at(22) });
  assert.equal(result.total, 22);
  assert.equal(result.verdict, "ok");
  assert.doesNotMatch(result.markdown, /\| result \|/);
});

test("a red total fails the step only when the gate is enforced, a yellow one never", () => {
  const red = [job("test shard 1", 3, 75)];
  const yellow = [job("test shard 1", 3, 55)];
  assert.equal(evaluate(started, red, { mode: "record", now: at(76) }).fail, false);
  assert.equal(evaluate(started, red, { mode: "enforce", now: at(76) }).fail, true);
  assert.equal(evaluate(started, yellow, { mode: "enforce", now: at(56) }).fail, false);
  assert.equal(evaluate(started, yellow, { mode: "enforce", now: at(56) }).verdict, "yellow");
  assert.match(evaluate(started, red, { mode: "record", now: at(76) }).markdown, /over the limit .*Recorded only: no status is written/);
  assert.match(evaluate(started, red, { mode: "enforce", now: at(76) }).markdown, /over the limit .*Enforced\./);
});

// ---- the wait for a runner ----

/** The jobs of a run in which every job but `late` was served within 3 seconds and ended by 51 s, and `late` waited `wait` seconds and ended at `end`. */
const runWithLateJob = (wait: number, end: number): Job[] => [
  job("check", 3, 12), job("no-tmp-workflow", 3, 8), job("nkey counts", 3, 51), job("test shard 2", 3, 40), job("test shard 1", 3 + wait, end, [], wait),
];

test("one job that waited a long time for a runner is counted without the wait beyond the quickest job's, and the total and the wait are both shown", () => {
  const result = evaluate(started, runWithLateJob(45, 81), { mode: "enforce", now: at(83) });
  // The other jobs ended by 51 s; the late job's end less its 42 s beyond the quickest wait of 3 s is 39 s; the status came 2 s after the last job.
  assert.deepEqual([result.total, result.counted, result.waited, result.verdict, result.fail], [83, 53, 30, "yellow", false]);
  assert.match(result.markdown, /\*\*53 s\*\* from the start of the run to the status, without the wait for a runner and the late marking of jobs complete: close to the limit/);
  assert.match(result.markdown, /The run took 83 s in all \(the last job, test shard 1, ended at 81 s\)\. 30 s of that is waiting for a runner beyond the 3 s that the quickest job of the run waited; test shard 1 waited 45 s\./);
  assert.match(result.markdown, /\| test shard 1 \| 45 \| 42 \| 33 \| 81 \|/);
});

test("a job that is itself slow stays red whatever the others waited, and a long wait does not hide it", () => {
  // Served as quickly as the rest, but it ran for 70 s.
  assert.deepEqual(evaluate(started, [...runWithLateJob(3, 12), job("nkey time-writing", 3, 73)], { mode: "enforce", now: at(75) }).counted, 75);
  // Waited 30 s and then ran for 50 s: its end less the 27 s beyond the quickest wait is 56 s, and the status came 2 s after it.
  const slowAfterWaiting = evaluate(started, [...runWithLateJob(3, 12), job("nkey time-writing", 33, 83, [], 30)], { mode: "enforce", now: at(85) });
  assert.deepEqual([slowAfterWaiting.total, slowAfterWaiting.counted, slowAfterWaiting.waited], [85, 58, 27]);
  const slower = evaluate(started, [...runWithLateJob(3, 12), job("nkey time-writing", 33, 93, [], 30)], { mode: "enforce", now: at(95) });
  assert.deepEqual([slower.counted, slower.verdict, slower.fail], [68, "red", true]);
});

test("when many jobs wait together, as at the limit of jobs an organization may run at once, each one's wait beyond the quickest job's comes off", () => {
  const jobs = [job("start", 3, 7), ...Array.from({ length: 26 }, (_, i) => job(`test shard ${i + 1}`, 21, 60, [], 20)), job("check", 3, 12)];
  const result = evaluate(started, jobs, { mode: "enforce", now: at(62) });
  assert.deepEqual([result.total, result.counted, result.waited, result.verdict], [62, 45, 17, "ok"]);
});

test("a run in which every job waited alike has nothing quicker to compare with, so that wait stays in the time", () => {
  const jobs = Array.from({ length: 5 }, (_, i) => job(`test shard ${i + 1}`, 33, 70, [], 30));
  const result = evaluate(started, jobs, { mode: "enforce", now: at(72) });
  assert.deepEqual([result.total, result.counted, result.waited, result.verdict], [72, 72, 0, "red"]);
  assert.equal(quickestWait(jobs), 30);
});

test("the job that reads is counted without its own extra wait, so a status that came late because it started late does not turn the run red", () => {
  // The other jobs waited 3 s and ended by 55 s; this job waited 66 s and started at 70 s, so the status came at 72 s.
  const jobs = [job("check", 3, 12), job("test shard 1", 3, 55), job("result", 70, 90, [], 66)];
  const result = evaluate(started, jobs, { mode: "enforce", now: at(72) });
  assert.deepEqual([result.total, result.counted, result.waited, result.verdict], [72, 57, 15, "yellow"]);
  // Had it started with the others, the same ends would give the total as it is.
  assert.deepEqual(evaluate(started, [jobs[0]!, jobs[1]!, job("result", 3, 90)], { mode: "enforce", now: at(57) }).counted, 57);
});

test("a run whose jobs waited for a runner no longer than the quickest one has its whole total counted", () => {
  const result = evaluate(started, [job("check", 3, 20), job("test shard 1", 3, 52)], { mode: "enforce", now: at(55) });
  assert.deepEqual([result.total, result.counted, result.waited], [55, 55, 0]);
  assert.equal(quickestWait([]), 0);
});

// The jobs of the full CI run 39211762302 on 10-19 (hosted runners), the one that was red for 83 s because test shard 1 waited 45 s for a runner while
// the other 27 jobs started within 3 s: [name, seconds after the run started that the job was created, started and ended]; the status came at 83 s.
const REAL_RUN: [string, number, number, number][] = [
  ["check", 1, 5, 12], ["test shard 5", 1, 4, 37], ["nkey witnesses", 1, 4, 49], ["test shard 12", 1, 4, 37], ["no-tmp-workflow", 1, 5, 8], ["test shard 7", 1, 4, 39],
  ["test shard 1", 2, 47, 81], ["nkey time-writing", 2, 5, 50], ["test shard 3", 2, 5, 40], ["start", 2, 5, 9], ["test shard 14", 2, 5, 39], ["test shard 11", 2, 5, 47],
  ["test shard 9", 2, 5, 44], ["nkey time-quiet", 2, 5, 42], ["test shard 8", 2, 5, 42], ["test shard 17", 2, 5, 41], ["test shard 2", 2, 5, 40], ["test shard 18", 2, 5, 34],
  ["test shard 10", 2, 5, 39], ["test shard 13", 2, 5, 35], ["test shard 16", 2, 5, 46], ["test shard 4", 2, 5, 37], ["test shard 19", 2, 5, 34], ["test shard 6", 2, 5, 36],
  ["nkey counts", 2, 5, 51], ["test shard 15", 2, 5, 36], ["test shard 20", 2, 5, 36],
];

test("the run that was red for 83 s because one shard waited for a runner is within the limit and says how long it waited", () => {
  const jobs: Job[] = [
    ...REAL_RUN.map(([name, created, from, to]): Job => ({ name, conclusion: "success", created_at: at(created), started_at: at(from), completed_at: at(to) })),
    { name: "result", status: "in_progress", conclusion: null, created_at: at(1), started_at: at(4), completed_at: null },
  ];
  const result = evaluate(started, jobs, { mode: "enforce", now: at(83) });
  assert.deepEqual([result.total, result.counted, result.waited, result.verdict, result.fail], [83, 53, 30, "yellow", false]);
  assert.deepEqual(statusOf(jobs, "result", result), { state: "success", description: "full CI success (27 jobs, 83 s, 30 s of it waiting for a runner, 0 s of it GitHub marking jobs complete late)" });
  // The same run judged by its total, as before, was red.
  assert.equal(verdictOf(result.total), "red");
});

// ---- GitHub marking a job complete late ----

// The jobs of the full CI run 39327317254 on 10-19 (hosted runners), run by hand on the head commit of ci-gate-45, which the time gate turned red for 108 s (109 s in all)
// with every test green: the 39 jobs other than `result` all ended their last step by 35 s, and 30 of them were marked complete only between 77 and 105 s,
// 47 to 76 s after it (the other 9 within 3 s).
// [name, seconds after the run started that the job started, its last step ended, GitHub marked it complete]; every job was created at 2 s. The job that reads,
// `result`, started at 5 s and its last step ended at 110 s.
const LAG_RUN: [string, number, number, number][] = [
  ["check", 5, 18, 20], ["test shard 20", 4, 24, 91], ["test shard 24", 4, 25, 80], ["nkey time-quiet", 5, 33, 83], ["nkey counts", 5, 28, 80], ["no-tmp-workflow", 5, 8, 10],
  ["test shard 11", 4, 28, 87], ["start", 5, 6, 8], ["test shard 5", 5, 29, 85], ["nkey witnesses", 6, 32, 82], ["nkey counts-out", 5, 29, 83], ["test shard 6", 5, 24, 26],
  ["test shard 27", 5, 23, 26], ["test shard 17", 5, 29, 87], ["nkey time-writing", 5, 35, 99], ["test shard 21", 5, 29, 86], ["test shard 3", 5, 31, 87],
  ["test shard 18", 5, 30, 85], ["test shard 19", 5, 27, 96], ["test shard 16", 5, 26, 95], ["test shard 13", 5, 23, 25], ["test shard 29", 5, 22, 25],
  ["test shard 9", 5, 34, 103], ["test shard 14", 6, 33, 92], ["test shard 15", 5, 29, 105], ["test shard 23", 5, 23, 25], ["test shard 28", 5, 32, 81],
  ["test shard 22", 5, 27, 80], ["test shard 1", 5, 31, 87], ["test shard 8", 5, 26, 88], ["test shard 12", 5, 28, 77], ["test shard 26", 5, 25, 89],
  ["nkey late-rows", 5, 31, 78], ["test shard 7", 5, 29, 87], ["test shard 25", 6, 31, 86], ["test shard 30", 5, 29, 84], ["test shard 10", 5, 22, 24],
  ["test shard 4", 5, 29, 80], ["test shard 2", 5, 29, 84],
];
const lagRunJobs = (): Job[] => [
  ...LAG_RUN.map(([name, from, last, marked]): Job => ({ name, conclusion: "success", created_at: at(2), started_at: at(from), completed_at: at(marked), steps: [{ name: "tests", started_at: at(from), completed_at: at(last) }] })),
  { name: "result", status: "in_progress", conclusion: null, created_at: at(2), started_at: at(5), completed_at: null },
];

test("the run that was red for 108 s because GitHub marked 30 jobs complete 47 to 76 s after their last step is counted at 44 s, with the late marking written apart", () => {
  const jobs = lagRunJobs();
  // The moment of the status is taken as the end of the last step of `result`, 110 s, as the recomputation of the 240 runs in docs/design.md does; the
  // status of the real run came at 109 s (below).
  const result = evaluate(started, jobs, { mode: "enforce", now: at(110) });
  // The latest job to end its last step is nkey time-writing, at 35 s; it counts as ended 5 s later, and the status came 5 s after the last job was marked.
  assert.deepEqual([result.total, result.counted, result.waited, result.markedLate, result.verdict, result.fail], [110, 44, 1, 65, "ok", false]);
  // Without the late marking the same jobs read 109 s at that moment, red.
  assert.equal(result.counted + result.markedLate, 109);
  assert.equal(verdictOf(109), "red");
  // At the moment of the real status, 109 s, they read the 108 s that the gate judged (its log: "108 s without the wait for a runner (109 s in all)") and now 43 s.
  const real = evaluate(started, jobs, { mode: "enforce", now: at(109) });
  assert.deepEqual([real.total, real.counted + real.markedLate, real.counted, real.verdict], [109, 108, 43, "ok"]);
  assert.deepEqual(statusOf(jobs, "result", result), { state: "success", description: "full CI success (39 jobs, 110 s, 1 s of it waiting for a runner, 65 s of it GitHub marking jobs complete late)" });
  assert.match(result.markdown, /\*\*44 s\*\* from the start of the run to the status, without the wait for a runner and the late marking of jobs complete: within the limit/);
  assert.match(result.markdown, /65 s of it is GitHub marking jobs complete more than 5 s after their last step; test shard 15 was marked 76 s after its last step\./);
  assert.match(result.markdown, /\| nkey time-writing \| 3 \| 1 \| 94 \| 99 \| 64 \|/);
  assert.match(result.markdown, /\| check \| 3 \| 1 \| 15 \| 20 \| 2 \|/);
});

test("a delay that holds back every job from the start of the run comes off too, as no job is marked on time to compare with", () => {
  const jobs = Array.from({ length: 5 }, (_, i) => markedLate(`test shard ${i + 1}`, 3, 90, 60));
  const result = evaluate(started, jobs, { mode: "enforce", now: at(92) });
  // Each job's last step ended at 30 s and counts as ended at 35 s; the status came 2 s after the last mark.
  assert.deepEqual([result.total, result.counted, result.waited, result.markedLate, result.verdict], [92, 37, 0, 55, "ok"]);
});

test("a job that is itself slow stays red whatever GitHub's delay, and the delay on top of it does not hide it", () => {
  // The last step ended at 75 s and the job was marked complete 2 s later, in time.
  assert.deepEqual(evaluate(started, [job("check", 2, 12), markedLate("test shard 1", 3, 77, 2)], { mode: "enforce", now: at(79) }).counted, 79);
  // The last step ended at 75 s and the job was marked complete 25 s later: it counts as ended at 80 s.
  const delayed = evaluate(started, [job("check", 2, 12), markedLate("test shard 1", 3, 100, 25)], { mode: "enforce", now: at(102) });
  assert.deepEqual([delayed.counted, delayed.markedLate, delayed.verdict, delayed.fail], [82, 20, "red", true]);
});

test("a delay of 5 seconds, the usual one at most, is not taken off, and every second beyond it is", () => {
  assert.equal(MARK_ALLOWANCE_SECONDS, 5);
  const withLag = (lag: number) => evaluate(started, [job("check", 3, 12), markedLate("test shard 1", 3, 55, lag)], { mode: "enforce", now: at(56) });
  assert.deepEqual([0, 2, 5].map(lag => [withLag(lag).counted, withLag(lag).markedLate]), [[56, 0], [56, 0], [56, 0]]);
  assert.deepEqual([6, 8, 30].map(lag => [withLag(lag).counted, withLag(lag).markedLate]), [[55, 1], [53, 3], [31, 25]]);
});

test("a job with no step that has ended is not taken off, and its delay is shown as unknown", () => {
  // `job` gives no steps; the other has a step that never ended.
  const unfinished: Job = { ...job("test shard 2", 3, 70), steps: [{ name: "tests", started_at: at(3), completed_at: null }] };
  const result = evaluate(started, [job("e2e", 4, 60), unfinished], { mode: "enforce", now: at(72) });
  assert.deepEqual([result.counted, result.markedLate], [72, 0]);
  assert.match(result.markdown, /\| e2e \| 3 \| 0 \| 56 \| 60 \| - \|/);
  assert.match(result.markdown, /\| test shard 2 \| 3 \| 0 \| 67 \| 70 \| - \|/);
});

test("a job marked complete before the end of its last step has no delay, not a negative one", () => {
  const early = job("check", 3, 40, [{ name: "tests", started_at: at(3), completed_at: at(43) }]);
  const result = evaluate(started, [early], { mode: "enforce", now: at(41) });
  assert.deepEqual([result.counted, result.markedLate], [41, 0]);
  assert.match(result.markdown, /\| check \| 3 \| 0 \| 37 \| 40 \| 0 \|/);
});

test("the last step is the one that ended latest, whatever the order of the steps in the list", () => {
  const steps = [{ name: "tests", started_at: at(3), completed_at: at(30) }, { name: "Post checkout", started_at: at(30), completed_at: at(20) }, { name: "Set up job", started_at: at(3), completed_at: null }];
  const result = evaluate(started, [job("test shard 1", 3, 60, steps)], { mode: "enforce", now: at(62) });
  // Marked 30 s after the step that ended at 30 s: 25 s beyond the 5 s; the later ones in the list ended earlier or not at all.
  assert.deepEqual([result.counted, result.markedLate], [37, 25]);
});

test("the late marking and the wait for a runner are taken off together and written apart, and the sum is what the run lost", () => {
  const jobs = [...runWithLateJob(45, 81), markedLate("nkey time-writing", 3, 70, 30)];
  const result = evaluate(started, jobs, { mode: "enforce", now: at(83) });
  // With only the wait for a runner taken off, the latest job to end is nkey time-writing at 70 s and the status could have been written at 72 s (11 s before the
  // 83 s). Its last step ended at 40 s, so it counts as ended at 45 s, the latest is nkey counts at 51 s and the status could have come at 53 s: 19 s more.
  assert.deepEqual([result.total, result.counted, result.waited, result.markedLate], [83, 53, 11, 19]);
  assert.equal(result.waited + result.markedLate, result.total - result.counted);
});

test("shards of one size name no slow shard, and one shard over 1.5 times the mean of the others is named", () => {
  assert.deepEqual(shardTable(evenShards(20)).filter(s => s.slow), []);
  const jobs = evenShards(20);
  jobs[2] = shard(3, 31);
  const slow = shardTable(jobs).filter(s => s.slow);
  assert.deepEqual(slow.map(s => [s.name, s.step, s.others]), [["test shard 3", 31, 20]]);
  const text = evaluate(started, jobs, { mode: "record", now: at(50) }).markdown;
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
  const unfinished: Job = { name: "test shard 2", conclusion: null, created_at: at(0), started_at: at(3), completed_at: at(20), steps: [{ name: "tests", started_at: at(15), completed_at: null }] };
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
  const text = evaluate(started, [job("check", 2, 20)], { mode: "record", now: at(22) }).markdown;
  assert.match(text, /No test shard found/);
  assert.doesNotMatch(evaluate(started, evenShards(20), { mode: "record", now: at(40) }).markdown, /No test shard found/);
});

// ---- the wait for the other jobs and the status ----

const open = (name: string): Job => ({ name, status: "in_progress", conclusion: null, created_at: at(0), started_at: at(3), completed_at: null });
const ended = (name: string, conclusion = "success"): Job => ({ name, status: "completed", conclusion, created_at: at(0), started_at: at(3), completed_at: at(30) });
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

test("the status is success when every other job succeeded or was skipped, and says how many jobs, how long and how much of it was waiting for a runner", () => {
  const jobs = [open("result"), ended("check"), ended("start", "skipped"), ended("test shard 1")];
  assert.deepEqual(statusOf(jobs, "result", { total: 48, waited: 0, markedLate: 0, fail: false }), { state: "success", description: "full CI success (3 jobs, 48 s, 0 s of it waiting for a runner, 0 s of it GitHub marking jobs complete late)" });
  assert.equal(statusOf(jobs, "result", { total: 71, waited: 14, markedLate: 6, fail: false }).description, "full CI success (3 jobs, 71 s, 14 s of it waiting for a runner, 6 s of it GitHub marking jobs complete late)");
});

test("the status is failure when a job did not succeed, naming up to four of them, whatever the gate says", () => {
  const jobs = [open("result"), ended("check", "failure"), ended("no-tmp-workflow", "cancelled"), ended("nkey counts", "failure"), ended("test shard 1")];
  const status = statusOf(jobs, "result", { total: 70, waited: 0, markedLate: 0, fail: true });
  assert.equal(status.state, "failure");
  assert.equal(status.description, "full CI failure (check, no-tmp-workflow, nkey counts not green)");
  const many = [open("result"), ...Array.from({ length: 6 }, (_, i) => ended(`test shard ${i + 1}`, "failure"))];
  assert.equal(statusOf(many, "result", { total: 40, waited: 0, markedLate: 0, fail: false }).description, "full CI failure (test shard 1, test shard 2, test shard 3, test shard 4 and 2 more not green)");
  // A job with no conclusion has not succeeded.
  assert.equal(statusOf([open("result"), { ...ended("check"), conclusion: null }], "result", { total: 40, waited: 0, markedLate: 0, fail: false }).state, "failure");
});

test("a red gate makes the status failure with the time and the wait in its description, and a description is cut at 140 characters", () => {
  const jobs = [open("result"), ended("check"), ended("test shard 1")];
  assert.deepEqual(statusOf(jobs, "result", { total: 75, waited: 10, markedLate: 20, fail: true }), { state: "failure", description: "full CI failure (time gate: 75 s, 10 s of it waiting for a runner, 20 s of it GitHub marking jobs complete late)" });
  const long = [open("result"), ended("a".repeat(80), "failure"), ended("b".repeat(80), "failure")];
  assert.equal(statusOf(long, "result", { total: 40, waited: 0, markedLate: 0, fail: false }).description.length, 140);
});

// ---- the whole script against a stand-in for the Actions API ----

const SCRIPT = fileURLToPath(new URL("../scripts/ci-time-gate.ts", import.meta.url));

/** Runs scripts/ci-time-gate.ts as a runner would, against a local server that answers as the API does for a run that started 50 s ago whose jobs have all
 * ended: `check` ended at 40 s after a wait of 3 s, `test shard 1` waited 33 s and ended at 48 s, and the job that reads has just started. The server
 * keeps the statuses it is sent. `broken` makes it answer the list of jobs with an error. */
async function runScript(options: { mode: string; checkConclusion?: string; broken?: boolean; checkMarkedAfter?: number }) {
  const t0 = Math.floor(Date.now() / 1000) * 1000 - 50_000;
  const iso = (s: number) => new Date(t0 + s * 1000).toISOString().replace(".000Z", "Z");
  const apiJob = (name: string, from: number, to: number | null, conclusion: string | null): Job => ({ name, status: to === null ? "in_progress" : "completed", conclusion, created_at: iso(0), started_at: iso(from), completed_at: to === null ? null : iso(to) });
  const check = apiJob("check", 3, 40, options.checkConclusion ?? "success");
  // `checkMarkedAfter` gives `check` a last step that ended that many seconds before GitHub marked it complete.
  if (options.checkMarkedAfter !== undefined) check.steps = [{ name: "tests", started_at: iso(3), completed_at: iso(40 - options.checkMarkedAfter) }];
  const jobs = [check, apiJob("test shard 1", 33, 48, "success"), apiJob("result", 3, null, null)];
  const statuses: { path: string; body: { state: string; context: string; description: string; target_url: string } }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => (body += chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      if (request.method === "POST") statuses.push({ path, body: JSON.parse(body) });
      if (options.broken && path.includes("/jobs")) { response.statusCode = 500; response.end("down"); return; }
      response.setHeader("Content-Type", "application/json");
      response.end(path.includes("/jobs") ? JSON.stringify({ jobs }) : JSON.stringify({ created_at: iso(0), run_started_at: iso(0) }));
    });
  });
  const directory = await mkdtemp(join(tmpdir(), "time-gate-"));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const env = {
      PATH: process.env.PATH ?? "", TIME_GATE: options.mode, GH_TOKEN: "token", GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "7", GITHUB_SHA: "abc123", GITHUB_JOB: "result",
      GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, GITHUB_OUTPUT: join(directory, "output"),
    };
    const code = await new Promise<number>(resolve => execFile(process.execPath, [SCRIPT], { env, timeout: 30_000 }, error => resolve(error === null ? 0 : typeof error.code === "number" ? error.code : -1)));
    const output = await readFile(env.GITHUB_OUTPUT, "utf8").catch(() => "");
    return { code, statuses, output };
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("enforced, the script writes the status with the total and the wait for a runner, and succeeds", async () => {
  const { code, statuses, output } = await runScript({ mode: "enforce" });
  assert.equal(code, 0);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.path, "/repos/owner/repo/statuses/abc123");
  assert.equal(statuses[0]!.body.state, "success");
  assert.equal(statuses[0]!.body.context, "full-ci");
  // The status comes a moment after the 50 s of the run. Served as soon as the quickest job, test shard 1 would have ended at 18 s and check, at 40 s, would have
  // ended last: 8 s before the 48 s at which the last job did.
  assert.match(statuses[0]!.body.description, /^full CI success \(2 jobs, (5\d) s, 8 s of it waiting for a runner, 0 s of it GitHub marking jobs complete late\)$/);
  assert.match(statuses[0]!.body.target_url, /\/owner\/repo\/actions\/runs\/7$/);
  assert.match(output, /written=true\n/);
  assert.match(output, /verdict=ok\ntotal=5\d\nwaited=8\n/);
});

test("enforced, a job marked complete 20 s after its last step is counted at 5 s after it, and the status and the output say how much was taken off", async () => {
  const { code, statuses, output } = await runScript({ mode: "enforce", checkMarkedAfter: 20 });
  assert.equal(code, 0);
  // check's last step ended at 20 s, so it counts as ended at 25 s and not 40 s: 15 s off, beside the 8 s of waiting for a runner.
  assert.match(statuses[0]!.body.description, /^full CI success \(2 jobs, (5\d) s, 8 s of it waiting for a runner, 15 s of it GitHub marking jobs complete late\)$/);
  assert.match(output, /verdict=ok\ntotal=5\d\nwaited=8\nmarked_late=15\n/);
});

test("enforced, a job that did not succeed makes the status failure and the script fail", async () => {
  const { code, statuses } = await runScript({ mode: "enforce", checkConclusion: "failure" });
  assert.equal(code, 1);
  assert.deepEqual(statuses.map(s => [s.body.state, s.body.description]), [["failure", "full CI failure (check not green)"]]);
});

test("recorded, the script writes no status and succeeds whatever the jobs did, but gives the same numbers", async () => {
  const { code, statuses, output } = await runScript({ mode: "record", checkConclusion: "failure" });
  assert.equal(code, 0);
  assert.deepEqual(statuses, []);
  assert.match(output, /verdict=ok\ntotal=5\d\nwaited=8\n/);
  assert.doesNotMatch(output, /written/);
});

test("when the API cannot be read, an enforced script writes a failure and fails, and a recorded one writes nothing and does not fail", async () => {
  const [enforced, recorded] = await Promise.all([runScript({ mode: "enforce", broken: true }), runScript({ mode: "record", broken: true })]);
  assert.equal(enforced.code, 1);
  assert.equal(enforced.statuses.length, 1);
  assert.match(enforced.statuses[0]!.body.description, /^full CI failure \(the result job failed: GET .*500/);
  assert.equal(recorded.code, 0);
  assert.deepEqual(recorded.statuses, []);
});

test("a mode that is neither enforce nor record is refused before the API is asked", async () => {
  const { code, statuses } = await runScript({ mode: "report" });
  assert.equal(code, 2);
  assert.deepEqual(statuses, []);
});
