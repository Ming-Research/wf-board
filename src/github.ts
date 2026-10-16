import { execFile } from "node:child_process";
import { z } from "zod";

/** What GitHub says about one repository, reduced to what the watch (src/watch.ts) uses. */

/** `none`: the commit has no checks at all, which is not green. */
export type CheckState = "success" | "failure" | "pending" | "none";
export interface Checks { state: CheckState; /** Names of the checks that failed. */ failed: string[] }
export interface MainLine { branch: string; commit: string; checks: Checks }
export interface PullState {
  number: number; title: string; url: string; draft: boolean;
  /** When GitHub opened it, ISO 8601. */
  createdAt: string;
  /** The branch the PR merges into. */
  base: string;
  /** Its newest commit, the one the checks belong to. */
  commit: string;
  /** `UNKNOWN` while GitHub still works it out. */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checks: Checks;
}
export interface NamedPull { number: number; state: "OPEN" | "MERGED" | "CLOSED"; url: string; mergedAt?: string }
export interface RepoState {
  /** `Owner/Name`, as the project's `repo` writes it. */
  repo: string;
  main?: MainLine;
  /** Every open PR, newest first; `truncated` when there were more than the query reads. */
  pulls: PullState[];
  truncated: boolean;
  /** The PRs asked for by number, whichever state they are in; one that does not exist is left out. */
  named: NamedPull[];
}
export interface GithubSource {
  /** `branch`: the main line when it is not the default branch. `numbers`: PRs to look up in any state. */
  query(repo: string, options: { branch?: string; numbers: number[] }): Promise<RepoState>;
}

/** The newest 100 open PRs and 100 checks per commit; a repository with more is reported as truncated or misses checks. */
const LIMIT = 100;
const CHECKS = `statusCheckRollup { contexts(first: ${LIMIT}) { pageInfo { hasNextPage } nodes { __typename ... on CheckRun { name status conclusion startedAt checkSuite { id } } ... on StatusContext { context state } } } }`;

/** One GraphQL query for a repository: its main line, its open PRs, and the PRs named by number (aliases p<N>, so the numbers go into the text; they are integers). */
export function queryText(branch: boolean, numbers: readonly number[]): string {
  for (const n of numbers) if (!Number.isInteger(n) || n < 1) throw new Error(`PR number ${n}: expected a positive integer`);
  const main = branch ? "main: ref(qualifiedName: $ref)" : "main: defaultBranchRef";
  const named = numbers.map(n => `p${n}: pullRequest(number: ${n}) { number state mergedAt url }`).join("\n");
  return `query($owner: String!, $name: String!${branch ? ", $ref: String!" : ""}) { repository(owner: $owner, name: $name) {
  ${main} { name target { ... on Commit { oid ${CHECKS} } } }
  pullRequests(states: OPEN, first: ${LIMIT}, orderBy: {field: CREATED_AT, direction: DESC}) { pageInfo { hasNextPage } nodes {
    number title url isDraft createdAt baseRefName headRefOid mergeable commits(last: 1) { nodes { commit { ${CHECKS} } } } } }
  ${named}
} }`;
}

const Context = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"), name: z.string(), status: z.string(), conclusion: z.string().nullable(), startedAt: z.string().nullable(),
    // The round of checks it belongs to: one workflow run for one event (a push, a pull request), and its reruns.
    checkSuite: z.object({ id: z.string() }),
  }),
  z.object({ __typename: z.literal("StatusContext"), context: z.string(), state: z.string() }),
]);
const Rollup = z.object({ contexts: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(Context) }) }).nullable();
const Response = z.object({
  data: z.object({
    repository: z.object({
      main: z.object({ name: z.string(), target: z.object({ oid: z.string(), statusCheckRollup: Rollup }).nullable() }).nullable(),
      pullRequests: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean() }),
        nodes: z.array(z.object({
          number: z.number(), title: z.string(), url: z.string(), isDraft: z.boolean(), createdAt: z.string(), baseRefName: z.string(), headRefOid: z.string(), mergeable: z.string(),
          commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: Rollup }) })) }),
        })),
      }),
    }).catchall(z.unknown()).nullable(),
  }).nullable(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});
const Named = z.object({ number: z.number(), state: z.enum(["OPEN", "MERGED", "CLOSED"]), mergedAt: z.string().nullable(), url: z.string() });

type CheckRun = Extract<z.infer<typeof Context>, { __typename: "CheckRun" }>;
const NOT_RUN = new Set(["NEUTRAL", "SKIPPED"]);
/** 2 failed, 1 unfinished, 0 succeeded or not run: how bad a run is, for runs that cannot be told apart by time. */
const badness = (run: CheckRun) => run.status !== "COMPLETED" ? 1 : run.conclusion === "SUCCESS" || (run.conclusion !== null && NOT_RUN.has(run.conclusion)) ? 0 : 2;
/** Whether `a` is the later attempt at the same check: it started later (a run not started yet is the latest), and of equal start the worse one. */
const later = (a: CheckRun, b: CheckRun) => {
  const x = a.startedAt ?? "9999", y = b.startedAt ?? "9999";
  return x !== y ? x > y : badness(a) >= badness(b);
};

/**
 * What the checks on a commit say, read from the checks themselves and not from GitHub's roll-up state, which counts a cancelled
 * run as a failure. It reads every check on the commit, whatever event started it: a repository's real checks may run on push,
 * on pull request, or both, and the same set is read in each case.
 * Within one round of checks (a check suite: one workflow run for one event, and its reruns) the attempts at one check, the same
 * name, count only by the latest; an earlier red that a rerun replaced says nothing. Different rounds count each by itself, so
 * the push round and the pull request round of one workflow (the second tests the branch merged with its target) are two checks,
 * and a red in either is a red. A cancelled run, which a newer push replaced, says nothing as long as another run of its check
 * is in the same round; a check with only cancelled runs in a round has not run, which is pending. Then any failed check makes
 * the commit a failure, whatever else is still running; otherwise any unfinished check, or
 * more checks than one answer holds, make it pending; otherwise it passed if at least one check succeeded. A skipped or neutral
 * check is no failure and no pass (a gate that was skipped ran nothing), so a commit with only those, like one with no check at
 * all, is `none`, which is not green.
 */
export function summarize(rollup: z.infer<typeof Rollup> | undefined): Checks {
  if (!rollup) return { state: "none", failed: [] };
  const failed = new Set<string>(), latest = new Map<string, CheckRun>(), cancelled = new Set<string>();
  let passed = 0, pending = rollup.contexts.pageInfo.hasNextPage;
  for (const node of rollup.contexts.nodes) {
    if (node.__typename === "CheckRun") {
      const key = `${node.checkSuite.id}/${node.name}`;
      if (node.status === "COMPLETED" && node.conclusion === "CANCELLED") { cancelled.add(key); continue; }
      const seen = latest.get(key);
      if (!seen || later(node, seen)) latest.set(key, node);
    } else if (node.state === "SUCCESS") passed++;
    else if (node.state === "FAILURE" || node.state === "ERROR") failed.add(node.context);
    else pending = true;
  }
  if ([...cancelled].some(key => !latest.has(key))) pending = true;
  for (const run of latest.values()) {
    if (badness(run) === 2) failed.add(run.name);
    else if (badness(run) === 1) pending = true;
    else if (run.conclusion === "SUCCESS") passed++;
  }
  return { state: failed.size ? "failure" : pending ? "pending" : passed ? "success" : "none", failed: [...failed] };
}

/** Reads the answer of `queryText`. `repo` is only copied into the result. */
export function parseResponse(repo: string, text: string): RepoState {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error(`${repo}: GitHub's answer is not JSON`); }
  const parsed = Response.safeParse(json);
  if (!parsed.success) throw new Error(`${repo}: GitHub's answer has an unexpected shape: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const repository = parsed.data.data?.repository;
  if (!repository) throw new Error(`${repo}: ${parsed.data.errors?.map(e => e.message).join("; ") || "GitHub returned no repository"}`);
  const { main, pullRequests, ...rest } = repository;
  const named: NamedPull[] = [];
  // An alias for a PR that does not exist comes back null (with an error that does not matter here).
  for (const [key, value] of Object.entries(rest)) {
    if (!/^p\d+$/.test(key) || value === null) continue;
    const pull = Named.parse(value);
    named.push({ number: pull.number, state: pull.state, url: pull.url, ...(pull.mergedAt ? { mergedAt: pull.mergedAt } : {}) });
  }
  return {
    repo,
    ...(main?.target ? { main: { branch: main.name, commit: main.target.oid, checks: summarize(main.target.statusCheckRollup) } } : {}),
    pulls: pullRequests.nodes.map(pull => ({
      number: pull.number, title: pull.title, url: pull.url, draft: pull.isDraft, createdAt: pull.createdAt, base: pull.baseRefName, commit: pull.headRefOid,
      mergeable: pull.mergeable === "MERGEABLE" || pull.mergeable === "CONFLICTING" ? pull.mergeable : "UNKNOWN",
      checks: summarize(pull.commits.nodes[0]?.commit.statusCheckRollup),
    })),
    truncated: pullRequests.pageInfo.hasNextPage,
    named,
  };
}

/** Runs `gh` with these arguments and returns what it printed; rejects with the error, whose `stdout` holds what was printed before it failed. */
export type Gh = (args: string[]) => Promise<string>;
export const runGh: Gh = args => new Promise((resolve, reject) => {
  execFile("gh", args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(Object.assign(error, { stdout })); else resolve(stdout);
  });
});

/** GitHub through the `gh` command line, which is signed in as the owner. */
export function ghSource(gh: Gh = runGh): GithubSource {
  return {
    async query(repo, { branch, numbers }) {
      const [owner, name] = repo.split("/");
      if (!owner || !name) throw new Error(`repo ${repo}: expected Owner/Name`);
      // -f sends the value as a string; -F would read "@file" and turn "true" or "12" into other types.
      const args = ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, ...(branch ? ["-f", `ref=refs/heads/${branch}`] : []), "-f", `query=${queryText(!!branch, numbers)}`];
      let text: string;
      // gh exits with an error when the answer holds any GraphQL error, such as a PR number that does not exist, yet still prints it.
      try { text = await gh(args); }
      catch (error) {
        const printed = (error as { stdout?: unknown }).stdout;
        if (typeof printed !== "string" || !printed.trim()) throw new Error(`${repo}: gh failed: ${error instanceof Error ? error.message : String(error)}`);
        text = printed;
      }
      return parseResponse(repo, text);
    },
  };
}
