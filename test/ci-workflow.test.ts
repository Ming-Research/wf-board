// The full CI's workflow file (.github/workflows/ci.yml; docs/design.md, section 11, The time gate): its job `result` starts with the run
// and waits for the others as they run, so it sees only the jobs the run listed before any of them started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { SELF_JOB } from "../scripts/ci-time-gate.ts";

type Workflow = { jobs: Record<string, { needs?: unknown }> };
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
