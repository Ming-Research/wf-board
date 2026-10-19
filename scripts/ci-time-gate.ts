// The last job of the full CI (`result`): it starts with the run, waits until every other job has ended, then reads how long the
// run took from its start to now, the time of each job and how evenly the test shards shared the work, writes the outcome to the
// head commit as the status `full-ci` and puts the table into the run's summary. The time that is judged is the total without the
// wait for a runner that some job had beyond the quickest job of the run: red above 60 s and yellow above 50 s (docs/design.md,
// section 11, The time gate). Items ci-shards-gate, ci-status-under-1min, ci-gate-queue-wait.
//
//   TIME_GATE=enforce|record node scripts/ci-time-gate.ts
//     (reads the run's jobs through the API; GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA; GITHUB_JOB names this job;
//     GITHUB_API_URL, which a runner sets, is the API's address)
//
// `enforce` writes the status and turns it red when the time is red. `record` is for a push to the main line: it writes the same
// summary and no status, and never fails, so that the main line shows how long each run waited for runners and a report cannot
// turn it red. The browser tests are the workflow browser.yml and are not in this run (item ci-browser-lane).
import { appendFileSync } from "node:fs";

export const LIMIT_SECONDS = { yellow: 50, red: 60 };
/** The job and the step of a test shard in ci.yml, whose seconds the shard table shows. */
export const SHARD_JOB = /^test shard \d+$/;
export const SHARD_STEP = "tests";
/** A shard that takes more than this many times the mean of the other shards is named in the summary. */
export const SHARD_RATIO = 1.5;

export interface Step { name: string; started_at: string | null; completed_at: string | null }
export interface Job { name: string; status?: string; conclusion: string | null; created_at: string; started_at: string | null; completed_at: string | null; steps?: Step[] }
export type Verdict = "ok" | "yellow" | "red";
export type Mode = "enforce" | "record";

/** The job that runs this script. */
export const SELF_JOB = "result";
/** The context of the status the run writes to the commit. */
export const STATUS_CONTEXT = "full-ci";
/** Milliseconds between two looks at the run's jobs: longer while more than FEW_OPEN jobs are open, so that a run asks the API 13 to 17 times
 * and not 50 (the token of a run may make 1,000 requests an hour for the whole repository), shorter at the end, when the last jobs decide the time. */
export const LOOK_MS = { many: 2000, few: 1000 };
export const FEW_OPEN = 4;
/** How long this job waits after finding a cancelled job. A run that is cancelled ends this job too within seconds, and then nothing is written
 * (the pending status of the newer run must stand); a job that timed out is cancelled in the same word and the run goes on. */
export const CANCEL_GRACE_MS = 10_000;

/** Looks at the run's jobs until every job but `self` has ended, and returns the last look. */
export async function waitForJobs(
  look: () => Promise<Job[]>,
  self: string,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<Job[]> {
  for (let graced = false; ; ) {
    const jobs = await look();
    const others = jobs.filter(job => job.name !== self);
    const open = others.filter(job => job.status !== "completed").length;
    if (others.length > 0 && open === 0) {
      if (graced || !others.some(job => job.conclusion === "cancelled")) return jobs;
      graced = true;
      await sleep(CANCEL_GRACE_MS);
      continue;
    }
    await sleep(open > FEW_OPEN ? LOOK_MS.many : LOOK_MS.few);
  }
}

/** The status the run writes: success when every other job succeeded or was skipped and the gate is not red, else failure with the reason.
 * The total and the part of it that was waiting for a runner are in the description either way. */
export function statusOf(jobs: readonly Job[], self: string, gate: { total: number; waited: number; fail: boolean }) {
  const others = jobs.filter(job => job.name !== self);
  const failed = others.filter(job => job.conclusion !== "success" && job.conclusion !== "skipped").map(job => job.name);
  const times = `${gate.total} s, ${gate.waited} s of it waiting for a runner`;
  let state: "success" | "failure" = "success", description = `full CI success (${others.length} jobs, ${times})`;
  if (failed.length > 0) {
    state = "failure";
    description = `full CI failure (${failed.slice(0, 4).join(", ")}${failed.length > 4 ? ` and ${failed.length - 4} more` : ""} not green)`;
  } else if (gate.fail) {
    state = "failure";
    description = `full CI failure (time gate: ${times})`;
  }
  // GitHub cuts a status description at 140 characters.
  return { state, description: description.slice(0, 140) };
}

const seconds = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

export function verdictOf(total: number): Verdict {
  return total > LIMIT_SECONDS.red ? "red" : total > LIMIT_SECONDS.yellow ? "yellow" : "ok";
}

/** The seconds a job that has started waited for a runner: from its creation, when the run lists it, to the start of its first step. */
const waitOf = (job: Job) => seconds(job.created_at, job.started_at!);

/** The least a job of this run waited for a runner: the wait of the job that was served soonest. The run's own best stands for a wait that
 * cannot be shorter, so no number is picked; a run in which every job waited long counts that wait, as it has nothing quicker to compare with. */
export function quickestWait(jobs: readonly Job[]) {
  const waits = jobs.filter(job => job.started_at !== null).map(waitOf);
  return waits.length === 0 ? 0 : Math.min(...waits);
}

/** The jobs that ran, each with the seconds it waited for a runner, the part of that wait beyond the quickest job's (`extra`), the seconds it took and the second
 * it ended at after the run started. `self` is the job that is reading, which has not ended. */
export function lanes(started: string, jobs: readonly Job[], self: string) {
  const floor = quickestWait(jobs);
  return jobs
    .filter(job => job.name !== self && job.started_at !== null && job.completed_at !== null)
    .map(job => ({ name: job.name, waited: waitOf(job), extra: waitOf(job) - floor, took: seconds(job.started_at!, job.completed_at!), ended: seconds(started, job.completed_at!) }))
    .sort((a, b) => b.ended - a.ended || (a.name < b.name ? -1 : 1));
}

/** The test shards with the seconds their test step took, and those that took more than SHARD_RATIO times the mean of the others. */
export function shardTable(jobs: readonly Job[]) {
  const shards = jobs
    .filter(job => SHARD_JOB.test(job.name))
    .flatMap(job => {
      const step = job.steps?.find(s => s.name === SHARD_STEP);
      return step?.started_at && step.completed_at ? [{ name: job.name, step: seconds(step.started_at, step.completed_at) }] : [];
    })
    .sort((a, b) => (a.name.length - b.name.length) || (a.name < b.name ? -1 : 1));
  const sum = shards.reduce((s, shard) => s + shard.step, 0);
  return shards.map(shard => {
    const others = shards.length > 1 ? (sum - shard.step) / (shards.length - 1) : null;
    return { ...shard, others, slow: others !== null && shard.step > SHARD_RATIO * others };
  });
}

/** The total is the seconds from `started` to `now`, the moment the status is written, so the wait for the job that reads, its set-up and its API calls
 * count; `now` is never before the end of the last job. The time that is judged leaves out what the run lost to waiting for a runner: each job's end
 * (and this job's own start) is moved back by the wait it had beyond the quickest job's, the latest of them is when the status could have been written
 * had every job been served as soon as the quickest one, and the delay after the last end (or this job's start, if that is later) is added to it.
 * A job that is itself slow ends late all the same, so it is still counted in full. */
export function evaluate(started: string, jobs: readonly Job[], options: { mode: Mode; self?: string; now: string }) {
  const self = options.self ?? SELF_JOB;
  const floor = quickestWait(jobs);
  const rows = lanes(started, jobs, self);
  const lastEnd = rows.reduce((max, row) => Math.max(max, row.ended), 0);
  const total = Math.max(seconds(started, options.now), lastEnd);
  const mine = jobs.find(job => job.name === self && job.started_at !== null);
  const myStart = mine ? seconds(started, mine.started_at!) : 0, myExtra = mine ? waitOf(mine) - floor : 0;
  const ready = Math.max(myStart - myExtra, ...rows.map(row => row.ended - row.extra));
  const counted = Math.max(0, Math.min(total, ready + Math.max(0, total - Math.max(myStart, lastEnd))));
  const waited = total - counted;
  const verdict = verdictOf(counted);
  const shards = shardTable(jobs);
  const out: string[] = ["### CI time gate", ""];
  const limits = `yellow above ${LIMIT_SECONDS.yellow} s, red above ${LIMIT_SECONDS.red} s`;
  const state = verdict === "ok" ? "within the limit" : verdict === "yellow" ? "close to the limit" : "over the limit";
  const longest = rows.reduce<(typeof rows)[number] | undefined>((max, row) => (max === undefined || row.waited > max.waited ? row : max), undefined);
  out.push(`**${counted} s** from the start of the run to the status, without the wait for a runner: ${state} (${limits}). ${options.mode === "enforce" ? "Enforced." : "Recorded only: no status is written and the run does not fail for it."}`, "");
  out.push(`The run took ${total} s in all (the last job, ${rows[0]?.name ?? "no job"}, ended at ${lastEnd} s). ${waited} s of that is waiting for a runner beyond the ${floor} s that the quickest job of the run waited${longest && longest.extra > 0 ? `; ${longest.name} waited ${longest.waited} s` : ""}.`, "");
  out.push("| job | waited for a runner (s) | beyond the quickest (s) | took (s) | ended at (s) |", "|---|---|---|---|---|", ...rows.map(r => `| ${r.name} | ${r.waited} | ${r.extra} | ${r.took} | ${r.ended} |`), "");
  if (shards.length === 0) out.push(`No test shard found (a job named like \`test shard 1\` with a step \`${SHARD_STEP}\`), so the shard table is left out.`, "");
  else {
    out.push("| test shard | tests step (s) | mean of the others (s) |", "|---|---|---|", ...shards.map(s => `| ${s.name} | ${s.step} | ${s.others === null ? "-" : s.others.toFixed(1)} |`), "");
    for (const s of shards.filter(s => s.slow)) out.push(`${s.name} took ${s.step} s, over ${SHARD_RATIO} times the mean of the other shards (${s.others!.toFixed(1)} s): give the files new costs in test/shard-costs.json from the per-file tables of the shard summaries.`, "");
  }
  return { total, waited, counted, verdict, fail: options.mode === "enforce" && verdict === "red", markdown: out.join("\n") };
}

if (import.meta.main) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_API_URL, GITHUB_STEP_SUMMARY, GITHUB_OUTPUT, GITHUB_JOB, TIME_GATE } = process.env;
  if ((TIME_GATE !== "enforce" && TIME_GATE !== "record") || !GH_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GITHUB_SHA) {
    console.error("usage: TIME_GATE=enforce|record GH_TOKEN=... GITHUB_REPOSITORY=owner/repo GITHUB_RUN_ID=... GITHUB_SHA=... node scripts/ci-time-gate.ts");
    process.exit(2);
  }
  const mode: Mode = TIME_GATE;
  const self = GITHUB_JOB ?? SELF_JOB;
  // A call that fails is tried again, so a hiccup of the API does not fail a run that otherwise passed.
  const api = async (method: "GET" | "POST", path: string, body?: object) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(`${GITHUB_API_URL ?? "https://api.github.com"}/repos/${GITHUB_REPOSITORY}${path}`, {
          method,
          headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (response.ok) return await response.json();
        throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  };
  let written = false;
  const writeStatus = async (status: { state: string; description: string }) => {
    await api("POST", `/statuses/${GITHUB_SHA}`, {
      ...status,
      context: STATUS_CONTEXT,
      target_url: `${GITHUB_SERVER_URL ?? "https://github.com"}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
    });
    written = true;
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, "written=true\n");
  };
  try {
    // The start of this attempt: a run started again keeps its creation time, which would count the wait for the rerun.
    const run = (await api("GET", `/actions/runs/${GITHUB_RUN_ID}`)) as { created_at: string; run_started_at?: string };
    let looks = 0;
    const jobs = await waitForJobs(async () => { looks++; return ((await api("GET", `/actions/runs/${GITHUB_RUN_ID}/jobs?per_page=100&filter=latest`)) as { jobs: Job[] }).jobs; }, self);
    const result = evaluate(run.run_started_at ?? run.created_at, jobs, { mode, self, now: new Date().toISOString() });
    const status = statusOf(jobs, self, result);
    if (mode === "enforce") await writeStatus(status);
    console.log(result.markdown);
    console.log(`status ${STATUS_CONTEXT}: ${mode === "enforce" ? "" : "not written, "}${status.state}, ${status.description} (${looks} looks at the jobs)`);
    if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${result.markdown}\n`);
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `verdict=${result.verdict}\ntotal=${result.total}\nwaited=${result.waited}\n`);
    if (result.verdict !== "ok") console.log(`::${result.verdict === "red" && mode === "enforce" ? "error" : "warning"} title=CI time gate::${result.counted} s without the wait for a runner (${result.total} s in all), limits: yellow above ${LIMIT_SECONDS.yellow} s, red above ${LIMIT_SECONDS.red} s`);
    process.exit(mode === "record" || status.state === "success" ? 0 : 1);
  } catch (error) {
    console.error(error);
    if (mode === "record") process.exit(0);
    // The status must not stay pending for a run that is over: say that this job could not tell.
    if (!written) try { await writeStatus({ state: "failure", description: `full CI failure (the result job failed: ${error instanceof Error ? error.message : String(error)})`.slice(0, 140) }); } catch (inner) { console.error(inner); }
    process.exit(1);
  }
}
