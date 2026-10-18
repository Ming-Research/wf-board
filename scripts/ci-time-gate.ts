// The time gate of the full CI, run by its last job (`result`): how long the run took from its start to the end of its
// last job, the same for each job, and how evenly the test shards shared the work. The total is red above 60 s and yellow
// above 50 s (docs/design.md, section 11, The time gate). Item ci-shards-gate.
//
//   TIME_GATE=report|enforce node scripts/ci-time-gate.ts    (reads the run's jobs through the API; GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID)
//
// `report` writes the summary and never fails; `enforce` fails the step when the total is red. The browser job still takes
// minutes in a run started by hand with `browser`, so the workflow reports until the browser checks leave the full CI (ci-browser-lane).
import { appendFileSync } from "node:fs";

export const LIMIT_SECONDS = { yellow: 50, red: 60 };
/** The job and the step of a test shard in ci.yml, whose seconds the shard table shows. */
export const SHARD_JOB = /^test shard \d+$/;
export const SHARD_STEP = "tests";
/** A shard that takes more than this many times the mean of the other shards is named in the summary. */
export const SHARD_RATIO = 1.5;

export interface Step { name: string; started_at: string | null; completed_at: string | null }
export interface Job { name: string; conclusion: string | null; started_at: string | null; completed_at: string | null; steps?: Step[] }
export type Verdict = "ok" | "yellow" | "red";

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

export function evaluate(started: string, jobs: readonly Job[], options: { enforce: boolean; self?: string }) {
  const rows = lanes(started, jobs, options.self ?? "result");
  const total = rows.reduce((max, row) => Math.max(max, row.ended), 0);
  const verdict = verdictOf(total);
  const shards = shardTable(jobs);
  const out: string[] = ["### CI time gate", ""];
  const limits = `yellow above ${LIMIT_SECONDS.yellow} s, red above ${LIMIT_SECONDS.red} s`;
  const state = verdict === "ok" ? "within the limit" : verdict === "yellow" ? "close to the limit" : "over the limit";
  out.push(`**${total} s** from the start of the run to the end of its last job (${rows[0]?.name ?? "no job"}): ${state} (${limits}). ${options.enforce ? "Enforced." : "Report only, not enforced."}`, "");
  out.push("| job | waited (s) | took (s) | ended at (s) |", "|---|---|---|---|", ...rows.map(r => `| ${r.name} | ${r.queued} | ${r.took} | ${r.ended} |`), "");
  if (shards.length === 0) out.push(`No test shard found (a job named like \`test shard 1\` with a step \`${SHARD_STEP}\`), so the shard table is left out.`, "");
  else {
    out.push("| test shard | tests step (s) | mean of the others (s) |", "|---|---|---|", ...shards.map(s => `| ${s.name} | ${s.step} | ${s.others === null ? "-" : s.others.toFixed(1)} |`), "");
    for (const s of shards.filter(s => s.slow)) out.push(`${s.name} took ${s.step} s, over ${SHARD_RATIO} times the mean of the other shards (${s.others!.toFixed(1)} s): give the files new costs in test/shard-costs.json from the per-file tables of the shard summaries.`, "");
  }
  return { total, verdict, fail: options.enforce && verdict === "red", markdown: out.join("\n") };
}

if (import.meta.main) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_STEP_SUMMARY, GITHUB_OUTPUT, TIME_GATE } = process.env;
  if ((TIME_GATE !== "report" && TIME_GATE !== "enforce") || !GH_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) {
    console.error("usage: TIME_GATE=report|enforce GH_TOKEN=... GITHUB_REPOSITORY=owner/repo GITHUB_RUN_ID=... node scripts/ci-time-gate.ts");
    process.exit(2);
  }
  // A read that fails is tried again, so a hiccup of the API does not fail a run that otherwise passed.
  const get = async (path: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}${path}`, { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" } });
        if (response.ok) return await response.json();
        throw new Error(`GET ${path || "run"}: ${response.status} ${await response.text()}`);
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  };
  // The start of this attempt: a run started again keeps its creation time, which would count the wait for the rerun.
  const run = (await get("")) as { created_at: string; run_started_at?: string };
  const { jobs } = (await get("/jobs?per_page=100&filter=latest")) as { jobs: Job[] };
  const result = evaluate(run.run_started_at ?? run.created_at, jobs, { enforce: TIME_GATE === "enforce" });
  console.log(result.markdown);
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${result.markdown}\n`);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `verdict=${result.verdict}\ntotal=${result.total}\n`);
  if (TIME_GATE === "enforce" && result.verdict !== "ok") console.log(`::${result.verdict === "red" ? "error" : "warning"} title=CI time gate::${result.total} s, limits: yellow above ${LIMIT_SECONDS.yellow} s, red above ${LIMIT_SECONDS.red} s`);
  process.exit(result.fail ? 1 : 0);
}
