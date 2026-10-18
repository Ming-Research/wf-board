import { execFile } from "node:child_process";
import { z } from "zod";
import { readChecks } from "./github.ts";
import type { CheckReading, ChecksRollup } from "./github.ts";

/** What the look at the checks (src/ci-watch.ts) asks GitHub, through the REST API: GraphQL cannot be asked conditionally, REST
 * can. A request that repeats an earlier one carries the ETag GitHub gave, and an answer of 304 (nothing changed) is not counted
 * against the hourly quota (docs/design.md, Watching GitHub, The look at the checks). */

/** A pull request as the look at the checks reads it. */
export interface CiPull {
  number: number; title: string; url: string; draft: boolean;
  /** Neither merged nor closed. */
  open: boolean;
  /** Its newest commit, the one the checks belong to. */
  commit: string;
}
export interface CiSource {
  /** The pull request now; undefined when the repository has none of that number. */
  pull(repo: string, number: number): Promise<CiPull | undefined>;
  /** What the checks and commit statuses on a commit say now, read as `summarize` reads them. */
  checks(repo: string, commit: string): Promise<CheckReading>;
  /** The requests left in the hourly quota as the newest answer said, undefined before any. */
  remaining(): number | undefined;
}

const PullBody = z.object({
  number: z.number(), title: z.string(), html_url: z.string(), draft: z.boolean().default(false), state: z.string(), merged: z.boolean().default(false),
  head: z.object({ sha: z.string() }),
});
const RunsBody = z.object({
  total_count: z.number(),
  check_runs: z.array(z.object({
    name: z.string(), status: z.string(), conclusion: z.string().nullable(), started_at: z.string().nullable(),
    // The round of checks it belongs to, as the check suite id; a run of no suite counts as a round of its own.
    check_suite: z.object({ id: z.number() }).nullable(),
  })),
});
const StatusBody = z.object({ total_count: z.number(), statuses: z.array(z.object({ context: z.string(), state: z.string(), target_url: z.string().nullable() })) });

/** The status a project's full CI writes (docs/design.md, section 11). It is pending without a link on every new commit of a pull
 * request until the engineer starts the run, which then writes the link to itself; a pending `full-ci` with no link is "no full CI
 * has been started", not a check that is running, so a round does not wait for it. The engineer's wait script reads it the same way. */
const FULL_CI = "full-ci";
const notStarted = (s: { context: string; state: string; target_url: string | null }) => s.context === FULL_CI && s.state === "pending" && !s.target_url;

/** The most checks and statuses one request reads; more are `unfinished`, as in the GraphQL look. */
const PAGE = 100;
/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 20_000;
/** How many answers are kept to be asked about again: far above the PRs the open items name at a time. */
const KEPT = 400;

export interface RestOptions {
  /** The token the requests are signed with. Read again after GitHub answers 401. */
  token: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
  baseUrl?: string;
}

/** An answer read once, with the ETag to ask about it again. */
interface Kept { etag: string; value: unknown }

/** GitHub through its REST API, signed in with the owner's token. */
export function restSource(o: RestOptions): CiSource {
  const get = o.fetch ?? fetch, now = o.now ?? Date.now, base = o.baseUrl ?? "https://api.github.com";
  const kept = new Map<string, Kept>();
  let token: Promise<string> | undefined, blockedUntil = 0, remaining: number | undefined;

  /** Asks for `path`; `read` turns the JSON of a 200 into the value kept for the next 304. undefined: GitHub has no such thing (404). */
  async function ask<T>(path: string, read: (json: unknown) => T): Promise<T | undefined> {
    if (now() < blockedUntil) throw new Error(`GitHub's quota is used up until ${new Date(blockedUntil).toISOString()}`);
    for (let attempt = 0; ; attempt++) {
      // One read of the token serves requests that start together.
      token ??= o.token().then(text => text.trim(), error => { token = undefined; throw error; });
      const bearer = await token;
      const earlier = kept.get(path);
      const response = await get(base + path, {
        headers: {
          authorization: `Bearer ${bearer}`,
          // The same every time: the ETag belongs to the answer for these headers, and GitHub answers 200 again when they differ.
          accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "wf-board",
          ...(earlier ? { "if-none-match": earlier.etag } : {}),
        },
        // A request GitHub never answers must not hold a look for good: the next look is 30 seconds away.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const left = Number(response.headers.get("x-ratelimit-remaining"));
      if (response.headers.get("x-ratelimit-remaining") !== null && Number.isFinite(left)) remaining = left;
      if (response.status === 304 && earlier) { response.body?.cancel().catch(() => {}); return earlier.value as T; }
      if (response.status === 404) { response.body?.cancel().catch(() => {}); kept.delete(path); return undefined; }
      if (response.status === 401 && attempt === 0) { token = undefined; response.body?.cancel().catch(() => {}); continue; }
      const retryAfter = response.headers.get("retry-after"), reset = Number(response.headers.get("x-ratelimit-reset"));
      if (response.status === 429 || (response.status === 403 && (retryAfter !== null || remaining === 0))) {
        // Out of quota, or told to slow down: no request is made until the time GitHub names (a minute when it names none).
        blockedUntil = now() + (retryAfter !== null && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : remaining === 0 && Number.isFinite(reset) ? Math.max(0, reset * 1000 - now()) : 60_000);
        response.body?.cancel().catch(() => {});
        throw new Error(`GitHub answered ${response.status} for ${path.split("?")[0]}; no request until ${new Date(blockedUntil).toISOString()}`);
      }
      if (response.status !== 200) { response.body?.cancel().catch(() => {}); throw new Error(`GitHub answered ${response.status} for ${path.split("?")[0]}`); }
      const value = read(await response.json());
      const etag = response.headers.get("etag");
      if (etag) {
        // Newest last, so the oldest go first when there are too many.
        kept.delete(path); kept.set(path, { etag, value });
        for (const key of kept.keys()) { if (kept.size <= KEPT) break; kept.delete(key); }
      }
      return value;
    }
  }
  const repoPath = (repo: string): string => {
    const [owner, name, extra] = repo.split("/");
    if (!owner || !name || extra !== undefined) throw new Error(`repo ${repo}: expected Owner/Name`);
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  };

  return {
    remaining: () => remaining,
    async pull(repo, number) {
      if (!Number.isInteger(number) || number < 1) throw new Error(`PR number ${number}: expected a positive integer`);
      const body = await ask(`${repoPath(repo)}/pulls/${number}`, json => PullBody.parse(json));
      return body && { number: body.number, title: body.title, url: body.html_url, draft: body.draft, open: body.state === "open" && !body.merged, commit: body.head.sha };
    },
    async checks(repo, commit) {
      if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error(`commit ${commit}: expected a hexadecimal object name`);
      const path = `${repoPath(repo)}/commits/${commit}`;
      // `filter=all`: every attempt of every round, as the GraphQL look reads them. The default keeps one run per name, which
      // would hide a red in one round behind a green of the same name in another.
      const [runs, statuses] = await Promise.all([
        ask(`${path}/check-runs?filter=all&per_page=${PAGE}`, json => RunsBody.parse(json)),
        ask(`${path}/status?per_page=${PAGE}`, json => StatusBody.parse(json)),
      ]);
      // A commit GitHub does not know has no checks either.
      const rollup: ChecksRollup = { contexts: {
        pageInfo: { hasNextPage: (runs?.total_count ?? 0) > (runs?.check_runs.length ?? 0) || (statuses?.total_count ?? 0) > (statuses?.statuses.length ?? 0) },
        nodes: [
          ...(statuses?.statuses ?? []).filter(s => !notStarted(s)).map(s => ({ __typename: "StatusContext" as const, context: s.context, state: s.state.toUpperCase() })),
          ...(runs?.check_runs ?? []).map(r => ({
            __typename: "CheckRun" as const, name: r.name, status: r.status.toUpperCase(), conclusion: r.conclusion === null ? null : r.conclusion.toUpperCase(),
            startedAt: r.started_at, checkSuite: { id: String(r.check_suite?.id ?? "none") },
          })),
        ],
      } };
      return readChecks(rollup);
    },
  };
}

/** The token of the account `gh` is signed in as: the one the other looks at GitHub (src/github.ts) already use. */
export function ghToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token"], { timeout: 30_000 }, (error, stdout) => {
      if (error) reject(new Error(`gh auth token failed: ${error.message}`));
      else if (!stdout.trim()) reject(new Error("gh auth token printed no token"));
      else resolve(stdout);
    });
  });
}
