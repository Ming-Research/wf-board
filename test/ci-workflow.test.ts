// The full CI's workflow file (.github/workflows/ci.yml; docs/design.md, section 11, The time gate): its job `result` starts with the run
// and waits for the others as they run, so it sees only the jobs the run listed before any of them started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { SELF_JOB } from "../scripts/ci-time-gate.ts";

/** The minutes after which GitHub cancels the step that runs the script (the step `result` of the job `result`). */
const SCRIPT_STEP = "result";

type Step = { id?: string; "timeout-minutes"?: number };
type Job = { needs?: unknown; "timeout-minutes"?: number; steps?: Step[] };
type Workflow = { jobs: Record<string, Job> };
const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
/** The ids of the jobs that wait for another job: the run lists them only when the other has ended, so `result` would not wait for them. */
const jobsWithNeeds = (text: string) => Object.entries((parse(text) as Workflow).jobs).filter(([, job]) => job.needs !== undefined).map(([id]) => id);

test("no job of the full CI waits for another with needs", () => {
  assert.deepEqual(jobsWithNeeds(ci), []);
});

test("the check finds a job that waits for another", () => {
  const spoiled = ci.replace("  check:\n", "  check:\n    needs: [no-tmp-workflow]\n");
  assert.notEqual(spoiled, ci);
  assert.deepEqual(jobsWithNeeds(spoiled), ["check"]);
});

test("the job the time gate leaves out of its wait is the job `result` of the workflow", () => {
  assert.ok(SELF_JOB in (parse(ci) as Workflow).jobs);
});

/** What would leave the status pending when a job is stuck: a timeout on the job `result`, which GitHub cancels without running another step; no
 * timeout on the step of the script; a job it waits for that has none, or one that is not shorter than the step's, so that the script would be cut off
 * before it saw the job end. */
const timeoutProblems = (text: string) => {
  const jobs = (parse(text) as Workflow).jobs;
  const problems: string[] = [];
  const step = jobs[SELF_JOB]?.steps?.find(s => s.id === SCRIPT_STEP)?.["timeout-minutes"];
  if (jobs[SELF_JOB]?.["timeout-minutes"] !== undefined) problems.push(`${SELF_JOB} has a timeout of its own`);
  if (step === undefined) problems.push(`the step ${SCRIPT_STEP} of ${SELF_JOB} has no timeout`);
  for (const [id, job] of Object.entries(jobs)) {
    if (id === SELF_JOB) continue;
    const minutes = job["timeout-minutes"];
    if (minutes === undefined) problems.push(`${id} has no timeout`);
    else if (step !== undefined && minutes >= step) problems.push(`${id} has a timeout of ${minutes} minutes, not shorter than the ${step} of the script`);
  }
  return problems;
};

test("a stuck job ends before the script's step does, and the job `result` has no timeout that would leave the status pending", () => {
  assert.deepEqual(timeoutProblems(ci), []);
});

test("the check finds a timeout on the job `result`, a script step with none, a job with none and a job not shorter than the step", () => {
  const onJob = ci.replace("  result:\n", "  result:\n    timeout-minutes: 10\n");
  const noStep = ci.replace("        timeout-minutes: 15\n", "");
  const noJob = ci.replace("  check:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n", "  check:\n    runs-on: ubuntu-latest\n");
  const long = ci.replace("  check:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n", "  check:\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n");
  for (const spoiled of [onJob, noStep, noJob, long]) assert.notEqual(spoiled, ci);
  assert.deepEqual(timeoutProblems(onJob), ["result has a timeout of its own"]);
  assert.deepEqual(timeoutProblems(noStep), ["the step result of result has no timeout"]);
  assert.deepEqual(timeoutProblems(noJob), ["check has no timeout"]);
  assert.deepEqual(timeoutProblems(long), ["check has a timeout of 15 minutes, not shorter than the 15 of the script"]);
});
