// The time gate of the full CI (scripts/ci-time-gate.ts; docs/design.md, section 11, The time gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMIT_SECONDS, SHARD_RATIO, evaluate, shardTable, verdictOf } from "../scripts/ci-time-gate.ts";
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

test("the total runs from the start of the run to the end of the job that ended last, not the sum of the jobs", () => {
  const jobs = [job("check", 2, 20), job("no-tmp-workflow", 2, 8), job("test shard 1", 3, 31), job("e2e", 4, 71)];
  const result = evaluate(started, jobs, { enforce: true });
  assert.equal(result.total, 71);
  assert.equal(result.verdict, "red");
  assert.match(result.markdown, /\*\*71 s\*\* from the start of the run to the end of its last job \(e2e\): over the limit/);
  assert.match(result.markdown, /\| e2e \| 4 \| 67 \| 71 \|/);
  assert.match(result.markdown, /\| check \| 2 \| 18 \| 20 \|/);
});

test("the job that is reading does not count, and neither does a job that never started", () => {
  const jobs = [job("check", 2, 20), { ...job("result", 80, 90) }, { name: "start", conclusion: "skipped", started_at: null, completed_at: null }, { name: "e2e", conclusion: null, started_at: at(5), completed_at: null }];
  const result = evaluate(started, jobs, { enforce: true });
  assert.equal(result.total, 20);
  assert.equal(result.verdict, "ok");
  assert.doesNotMatch(result.markdown, /\| result \|/);
});

test("a red total fails the step only when the gate is enforced, a yellow one never", () => {
  const red = [job("test shard 1", 3, 75)];
  const yellow = [job("test shard 1", 3, 55)];
  assert.equal(evaluate(started, red, { enforce: false }).fail, false);
  assert.equal(evaluate(started, red, { enforce: true }).fail, true);
  assert.equal(evaluate(started, yellow, { enforce: true }).fail, false);
  assert.equal(evaluate(started, yellow, { enforce: true }).verdict, "yellow");
  assert.match(evaluate(started, red, { enforce: false }).markdown, /over the limit .*Report only, not enforced/);
  assert.match(evaluate(started, red, { enforce: true }).markdown, /over the limit .*Enforced\./);
});

test("shards of one size name no slow shard, and one shard over 1.5 times the mean of the others is named", () => {
  assert.deepEqual(shardTable(evenShards(20)).filter(s => s.slow), []);
  const jobs = evenShards(20);
  jobs[2] = shard(3, 31);
  const slow = shardTable(jobs).filter(s => s.slow);
  assert.deepEqual(slow.map(s => [s.name, s.step, s.others]), [["test shard 3", 31, 20]]);
  const text = evaluate(started, jobs, { enforce: false }).markdown;
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
  const text = evaluate(started, [job("check", 2, 20)], { enforce: false }).markdown;
  assert.match(text, /No test shard found/);
  assert.doesNotMatch(evaluate(started, evenShards(20), { enforce: false }).markdown, /No test shard found/);
});
