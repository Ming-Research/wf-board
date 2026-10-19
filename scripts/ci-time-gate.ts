// The last job of the full CI (`result`): it starts with the run, waits until every other job has ended, then reads how long the
// run took from its start to now, the time of each job and how evenly the test shards shared the work, writes the outcome to the
// head commit as the status `full-ci` and puts the table into the run's summary. The total is red above 60 s and yellow above 50 s
// (docs/design.md, section 11, The time gate). Items ci-shards-gate, ci-status-under-1min.
//
//   TIME_GATE=report|enforce node scripts/ci-time-gate.ts
//     (reads the run's jobs through the API; GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA; GITHUB_JOB names this job)
//
// `report` never turns the status red for the time; `enforce` does when the total is red. The full CI enforces: the browser tests
// are the workflow browser.yml and are not in its path (item ci-browser-lane).
import { appendFileSync } from "node:fs";

export const LIMIT_SECONDS = { yellow: 50, red: 60 };
/** The job and the step of a test shard in ci.yml, whose seconds the shard table shows. */
export const SHARD_JOB = /^test shard \d+$/;
export const SHARD_STEP = "tests";
/** A shard that takes more than this many times the mean of the other shards is named in the summary. */
export const SHARD_RATIO = 1.5;

export interface Step { name: string; started_at: string | null; completed_at: string | null }
export interface Job { name: string; status?: string; conclusion: string | null; started_at: string | null; completed_at: string | null; steps?: Step[] }
export type Verdict = "ok" | "yellow" | "red";

/** The job that runs this script. */
export const SELF_JOB = "result";
/** The context of the status the run writes to the commit. */
export const STATUS_CONTEXT = "full-ci";
/** Milliseconds between two looks at the run's jobs: longer while more than FEW_OPEN jobs are open, so that a run asks the API about 25 times
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

/** The status the run writes: success when every other job succeeded or was skipped and the gate is not red, else failure with the reason. */
export function statusOf(jobs: readonly Job[], self: string, gate: { total: number; fail: boolean }) {
  const others = jobs.filter(job => job.name !== self);
  const failed = others.filter(job => job.conclusion !== "success" && job.conclusion !== "skipped").map(job => job.name);
  let state: "success" | "failure" = "success", description = `full CI success (${others.length} jobs, ${gate.total} s)`;
  if (failed.length > 0) {
    state = "failure";
    description = `full CI failure (${failed.slice(0, 4).join(", ")}${failed.length > 4 ? ` and ${failed.length - 4} more` : ""} not green)`;
  } else if (gate.fail) {
    state = "failure";
    description = `full CI failure (time gate: ${gate.total} s)`;
  }
  // GitHub cuts a status description at 140 characters.
  return { state, description: description.slice(0, 140) };
}

const seconds = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

export function verdictOf(total: number): Verdict {
  return total > LIMIT_SECONDS.red ? "red" : total > LIMIT_SECONDS.yellow ? "yellow" : "ok";
}

/** The jobs that ran, each with the seconds it waited after the run started, the seconds it took and the second it ended at. `self` is the job that is reading, which has not ended. */
export function lanes(started: string, jobs: readonly Job[], self: string) {
  return jobs
    .filter(job => job.name !== self && job.started_at !== null && job.completed_at !== null)
    .map(job => ({ name: job.name, queued: seconds(started, job.started_at!), took: seconds(job.started_at!, job.completed_at!), ended: seconds(started, job.completed_at!) }))
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
 * count; `now` is never before the end of the last job. */
export function evaluate(started: string, jobs: readonly Job[], options: { enforce: boolean; self?: string; now: string }) {
  const rows = lanes(started, jobs, options.self ?? SELF_JOB);
  const lastEnd = rows.reduce((max, row) => Math.max(max, row.ended), 0);
  const total = Math.max(seconds(started, options.now), lastEnd);
  const verdict = verdictOf(total);
  const shards = shardTable(jobs);
  const out: string[] = ["### CI time gate", ""];
  const limits = `yellow above ${LIMIT_SECONDS.yellow} s, red above ${LIMIT_SECONDS.red} s`;
  const state = verdict === "ok" ? "within the limit" : verdict === "yellow" ? "close to the limit" : "over the limit";
  out.push(`**${total} s** from the start of the run to the status (the last job, ${rows[0]?.name ?? "no job"}, ended at ${lastEnd} s): ${state} (${limits}). ${options.enforce ? "Enforced." : "Report only, not enforced."}`, "");
  out.push("| job | waited (s) | took (s) | ended at (s) |", "|---|---|---|---|", ...rows.map(r => `| ${r.name} | ${r.queued} | ${r.took} | ${r.ended} |`), "");
  if (shards.length === 0) out.push(`No test shard found (a job named like \`test shard 1\` with a step \`${SHARD_STEP}\`), so the shard table is left out.`, "");
  else {
    out.push("| test shard | tests step (s) | mean of the others (s) |", "|---|---|---|", ...shards.map(s => `| ${s.name} | ${s.step} | ${s.others === null ? "-" : s.others.toFixed(1)} |`), "");
    for (const s of shards.filter(s => s.slow)) out.push(`${s.name} took ${s.step} s, over ${SHARD_RATIO} times the mean of the other shards (${s.others!.toFixed(1)} s): give the files new costs in test/shard-costs.json from the per-file tables of the shard summaries.`, "");
  }
  return { total, verdict, fail: options.enforce && verdict === "red", markdown: out.join("\n") };
}

if (import.meta.main) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_STEP_SUMMARY, GITHUB_OUTPUT, GITHUB_JOB, TIME_GATE } = process.env;
  if ((TIME_GATE !== "report" && TIME_GATE !== "enforce") || !GH_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GITHUB_SHA) {
    console.error("usage: TIME_GATE=report|enforce GH_TOKEN=... GITHUB_REPOSITORY=owner/repo GITHUB_RUN_ID=... GITHUB_SHA=... node scripts/ci-time-gate.ts");
    process.exit(2);
  }
  const self = GITHUB_JOB ?? SELF_JOB;
  // A call that fails is tried again, so a hiccup of the API does not fail a run that otherwise passed.
  const api = async (method: "GET" | "POST", path: string, body?: object) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
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
    const result = evaluate(run.run_started_at ?? run.created_at, jobs, { enforce: TIME_GATE === "enforce", self, now: new Date().toISOString() });
    const status = statusOf(jobs, self, result);
    await writeStatus(status);
    console.log(result.markdown);
    console.log(`status ${STATUS_CONTEXT}: ${status.state}, ${status.description} (${looks} looks at the jobs)`);
    if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${result.markdown}\n`);
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `verdict=${result.verdict}\ntotal=${result.total}\n`);
    if (TIME_GATE === "enforce" && result.verdict !== "ok") console.log(`::${result.verdict === "red" ? "error" : "warning"} title=CI time gate::${result.total} s, limits: yellow above ${LIMIT_SECONDS.yellow} s, red above ${LIMIT_SECONDS.red} s`);
    process.exit(status.state === "success" ? 0 : 1);
  } catch (error) {
    console.error(error);
    // The status must not stay pending for a run that is over: say that this job could not tell.
    if (!written) try { await writeStatus({ state: "failure", description: `full CI failure (the result job failed: ${error instanceof Error ? error.message : String(error)})`.slice(0, 140) }); } catch (inner) { console.error(inner); }
    process.exit(1);
  }
}
