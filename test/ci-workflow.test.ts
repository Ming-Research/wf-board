// The full CI's workflow file (.github/workflows/ci.yml; docs/design.md, section 11, The time gate): its job `result` starts with the run
// and waits for the others as they run, so it sees only the jobs the run listed before any of them started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { SELF_JOB } from "../scripts/ci-time-gate.ts";

/** The id of the step of the job `result` that runs the script. */
const SCRIPT_STEP = "result";

type Step = { id?: string; if?: string; run?: string; "timeout-minutes"?: number };
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

/** What would leave the status pending when a job is stuck: a timeout on the job `result`, which GitHub cancels without running another step; a step of
 * that job with none (a step that hangs holds the job for the default 360 minutes, and the step after it runs no sooner); a job it waits for that has none, or
 * one that is not shorter than the script's step, so that the script would be cut off before it saw the job end. */
const timeoutProblems = (text: string) => {
  const jobs = (parse(text) as Workflow).jobs;
  const problems: string[] = [];
  const steps = jobs[SELF_JOB]?.steps ?? [];
  const step = steps.find(s => s.id === SCRIPT_STEP)?.["timeout-minutes"];
  if (jobs[SELF_JOB]?.["timeout-minutes"] !== undefined) problems.push(`${SELF_JOB} has a timeout of its own`);
  if (step === undefined) problems.push(`the step ${SCRIPT_STEP} of ${SELF_JOB} has no timeout`);
  steps.forEach((s, i) => {
    if (s.id !== SCRIPT_STEP && s["timeout-minutes"] === undefined) problems.push(`step ${i + 1} of ${SELF_JOB} has no timeout`);
  });
  for (const [id, job] of Object.entries(jobs)) {
    if (id === SELF_JOB) continue;
    const minutes = job["timeout-minutes"];
    if (minutes === undefined) problems.push(`${id} has no timeout`);
    else if (step !== undefined && minutes >= step) problems.push(`${id} has a timeout of ${minutes} minutes, not shorter than the ${step} of the script`);
  }
  return problems;
};

/** The step after the script's that writes a failure when the script wrote none: it must run when a step failed and only if the script did not write a status
 * (else it would replace the real one), and write the status `full-ci` as failed. Without it a script that cannot run leaves the status pending. */
const fallbackProblems = (text: string) => {
  const steps = (parse(text) as Workflow).jobs[SELF_JOB]?.steps ?? [];
  const at = steps.findIndex(s => s.id === SCRIPT_STEP);
  if (at < 0) return [`${SELF_JOB} has no step ${SCRIPT_STEP}`];
  const writes = steps.slice(at + 1).some(s => {
    const when = String(s.if ?? ""), run = s.run ?? "";
    return when.includes("failure()") && when.includes(`steps.${SCRIPT_STEP}.outputs.written`) && run.includes("state=failure") && run.includes("context=full-ci");
  });
  return writes ? [] : ["no step after the script's runs on a failure, unless the script wrote the status, and writes a failed full-ci"];
};

test("the job `result` has no timeout that would leave the status pending, each of its steps has one, and the jobs it waits for have shorter ones than the script's", () => {
  assert.deepEqual(timeoutProblems(ci), []);
});

test("the check finds a timeout on the job `result`, a step with none, a job with none and a job not shorter than the script's step", () => {
  const onJob = ci.replace("  result:\n", "  result:\n    timeout-minutes: 10\n");
  const noScript = ci.replace("        timeout-minutes: 15\n", "");
  const noCheckout = ci.replace("      - uses: actions/checkout@v5\n        timeout-minutes: 5\n", "      - uses: actions/checkout@v5\n");
  const noJob = ci.replace("  check:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n", "  check:\n    runs-on: ubuntu-latest\n");
  const long = ci.replace("  check:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n", "  check:\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n");
  for (const spoiled of [onJob, noScript, noCheckout, noJob, long]) assert.notEqual(spoiled, ci);
  assert.deepEqual(timeoutProblems(onJob), ["result has a timeout of its own"]);
  assert.deepEqual(timeoutProblems(noScript), ["the step result of result has no timeout"]);
  assert.deepEqual(timeoutProblems(noCheckout), ["step 1 of result has no timeout"]);
  assert.deepEqual(timeoutProblems(noJob), ["check has no timeout"]);
  assert.deepEqual(timeoutProblems(long), ["check has a timeout of 15 minutes, not shorter than the 15 of the script"]);
});

test("a step after the script's writes a failed full-ci when the script wrote no status", () => {
  assert.deepEqual(fallbackProblems(ci), []);
});

test("the check finds a fallback step that never runs, one that runs after a status was written, one that writes success and one that writes another context", () => {
  const never = ci.replace("failure() && steps.result.outputs.written != 'true'", "success()");
  const overwrites = ci.replace("failure() && steps.result.outputs.written != 'true'", "failure()");
  const succeeds = ci.replace("-f state=failure", "-f state=success");
  const elsewhere = ci.replace("-f state=failure -f context=full-ci", "-f state=failure -f context=other");
  for (const spoiled of [never, overwrites, succeeds, elsewhere]) assert.notEqual(spoiled, ci);
  for (const spoiled of [never, overwrites, succeeds, elsewhere]) assert.equal(fallbackProblems(spoiled).length, 1);
});
