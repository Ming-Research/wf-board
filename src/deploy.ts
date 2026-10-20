import type { Checks } from "./github.ts";
import type { Notify } from "./notify.ts";
import { installedValues, renderPlist } from "./service-config.ts";

/** The daemon's service file as the repository holds it: a template (docs/design.md, section 4, Deploying). */
const SERVICE_TEMPLATE = "ops/wf-board.plist";

/** The paths whose change needs no restart, the one place this is defined. The daemon loads src/ and the packages at its start and
 * reads nothing else of the checkout except the page files, which it reads from disk on each request (web/index.html, and the
 * bundle web/dist/app.js and diagram library web/dist/mermaid.js the deploy builds); test/deploy.test.ts guards both claims. A change to any other path, listed here
 * or not, restarts the daemon. An entry ending in "/" is a directory and matches every path under it; any other entry is one exact path. */
export const NO_RESTART = ["docs/", "design/", "test/", "web/", "README.md", "LICENSE", "AGENTS.md", ".gitmodules", "Makefile", ".github/"];

/** A request for a push, in the shape POST /api/wake takes: the kind (src/wake.ts, WAKE_KINDS) and the fields its `external` lists. `repo` is
 * the repository as `Owner/Name` (null when it cannot be told) and `changes` the main-line commits the deploy concerns, as
 * `<short hash> <subject>`: the board finds the pull requests they name and the sessions whose items deliver them. */
export interface Push { event: "deployed" | "deployFailed"; [field: string]: unknown }

/** The daemon turned a request down for what it says (a 4xx answer, as for a request in the shape an older job sent): asking
 * again gets the same answer. */
export class PushRefused extends Error {}
/** Whether an HTTP status says the request itself is wrong, so sending it again is pointless: a 4xx, except when the daemon asks for
 * time (408, 429). */
export const refusesRequest = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 429;

/** A deploy that began and did not end, or a rollback that did not finish: the commit to go back to. The next run finishes it
 * before it does anything else, so a failure part way is never left as the new state of the checkout. */
export interface Pending {
  /** The commit being deployed. */
  target: string;
  /** The last healthy commit: where the checkout, its packages, its page and the daemon go back to. */
  to: string;
  /** A restart was begun for this deploy, so the daemon may run the target's code. */
  restarted: boolean;
  /** Where the checkout's HEAD may be if only the job has moved it: where the job put it last, and, while it is moving it, where
   * it is about to. Anywhere else was someone's doing, even on the deploy's target or the commit to go back to. */
  heads: string[];
  /** The target is the commit the checkout already holds: only the service file changes, so going back moves and builds no code. */
  inPlace?: boolean;
  /** The installed service file as it was before this deploy replaced it: set when the replacement begins, written back when going back. */
  config?: string;
}

/** The kinds of standing problem that are pushed once: the fetch fails, a refusal to move the checkout, a rollback that did not
 * finish, the job itself failing, the checks of the commit that cannot be read or that stay unfinished. */
export type ToldKind = "fetch" | "refuse" | "stuck" | "error" | "checks";

/** What the job keeps between runs, in a file beside no board data. */
export interface DeployState {
  /** The commit the board last served healthy: where a failed deploy goes back to when the board was already down. */
  healthy?: string;
  /** The commit whose deploy failed; it is not tried again until the remote moves on. */
  failed?: string;
  pending?: Pending;
  /** The commit whose checks have not finished (or have not appeared), and when the job first found it so. */
  waiting?: { commit: string; since: number };
  /** The standing problems already pushed, one entry per kind, so that each is pushed once even when two kinds of problem
   * come and go in turn; a run that ends with nothing wrong forgets them. */
  told?: Partial<Record<ToldKind, string>>;
  /** Pushes the daemon did not take (it was down), sent first on the next run. */
  outbox: Push[];
}

/** The daemon's installed service file, which the job keeps equal to what the checkout's template renders to. */
export interface ServiceDeps {
  /** The text of the installed file, or undefined when none is installed: the daemon is then not one the job configures. */
  installed(): Promise<string | undefined>;
  /** What the installer's `{{HOME}}` took: the home of the user the file is installed for. */
  home: string;
  /** Write the file, stop the service and load it again from the file, which starts the daemon (launchctl bootout, bootstrap: `kickstart`
   * does not read the file again); rejects when launchctl does. */
  replace(text: string): Promise<void>;
}

export interface DeployDeps {
  branch: string;
  remote: string;
  /** git in the checkout; rejects with the exit status as `code` when git fails. */
  git(args: string[]): Promise<string>;
  /** git against the remote (`fetch`): the same as `git`, and bounded in time, so a remote that never answers fails the fetch
   * instead of holding the job, which launchd never overlaps (src/net-git.ts). */
  network(args: string[]): Promise<string>;
  /** A command of the deploy (npm) in the checkout; rejects when it fails. */
  run(command: string, args: string[]): Promise<void>;
  /** The pid launchd reports for the daemon, or undefined while it is not running. */
  pid(): Promise<number | undefined>;
  /** launchctl kickstart -k on the daemon's own label: it restarts that service and nothing else. */
  restart(): Promise<void>;
  /** The daemon's service file; without it the job leaves the file alone. */
  service?: ServiceDeps;
  /** Whether /health answers. */
  healthy(): Promise<boolean>;
  /** The checks GitHub holds on a commit of the repository (`Owner/Name`), read as the board's look at the main line reads them
   * (src/github.ts); rejects when they cannot be read. */
  checks(repo: string, commit: string): Promise<Checks>;
  /** Hand a push to the daemon; rejects when it does not take it. */
  post(push: Push): Promise<void>;
  /** Tell the owner on the Mac (src/notify.ts): used only when the board is not answering and could not be brought back, so no daemon can push. */
  notify: Notify;
  load(): DeployState;
  save(state: DeployState): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(message: string): void;
  /** How long a restarted daemon has to answer, and how long it must keep answering from the same process. */
  waitMs: number;
  stableMs: number;
  /** How far apart the tries of a fetch are. */
  fetchRetryMs: number;
}

/** `stuck`: going back did not finish but the daemon answers; `down`: it does not answer either; `error`: the job itself failed;
 * `waiting`: the checks of the main line's head have not finished; `held`: one of them failed; `unchecked`: they could not be read;
 * `reconfigured`: the commit was already live and only the service file was replaced. */
export type DeployOutcome = "current" | "deployed" | "reconfigured" | "rolledBack" | "stuck" | "down" | "refused" | "skipped" | "unreachable" | "waiting" | "held" | "unchecked" | "error";

/** The most commits one deploy push lists; the rest are counted. */
const MAX_CHANGES = 20;
/** How long a probe of /health keeps trying before it says the daemon does not answer: one probe can miss a daemon that is busy or just starting. */
const SETTLE_MS = 15_000;
/** A commit whose checks have not finished after this long is pushed once: they may never finish, and nothing else says why the board is not deployed. */
const CHECKS_LATE_MS = 60 * 60_000;
/** A fetch is tried this often, this far apart, before the remote counts as unreachable: a network that has just come back needs a moment. */
const FETCH_TRIES = 3;

const line = (text: string) => text.trim();
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim().split("\n").slice(0, 3).join(" ").slice(0, 300);

/** One run of the deploy job: move the checkout to the main line's head and restart the daemon on it when that is needed, replace the
 * daemon's service file when the head's template renders to another text, go back to the last healthy commit (and the old file) when the
 * daemon does not come up, and tell the engineer holding the item either way, the architect when none does (docs/design.md, Running). */
export async function deployOnce(d: DeployDeps): Promise<DeployOutcome> {
  const state = d.load();
  const save = () => d.save(state);
  async function flush() {
    while (state.outbox.length) {
      try { await d.post(state.outbox[0]!); }
      catch (error) {
        // A refused request never becomes acceptable, and kept it would hold back every push behind it.
        if (!(error instanceof PushRefused)) { d.log(`push not taken, kept for the next run: ${reasonOf(error)}`); return; }
        d.log(`push refused, dropped: ${reasonOf(error)}`);
      }
      state.outbox.shift(); save();
    }
  }
  async function tell(push: Push) { state.outbox.push(push); save(); await flush(); }
  /** Push a standing problem once: `key` says which of its kind it is. True when it was pushed now. */
  async function tellOnce(kind: ToldKind, key: string, push: () => Promise<Push>): Promise<boolean> {
    const told = state.told ??= {};
    if (told[kind] === key) return false;
    told[kind] = key; await tell(await push());
    return true;
  }
  /** The repository as `Owner/Name`, from the remote's address, or null when it cannot be read. */
  async function repoName(): Promise<string | null> {
    try { return /[:/]([^:/]+\/[^/]+?)(?:\.git)?\/?$/.exec(line(await d.git(["remote", "get-url", d.remote])))?.[1] ?? null; } catch { return null; }
  }
  /** The first-parent commits after `from` up to `to`, as `<short hash> <subject>`, at most MAX_CHANGES and then how many more. */
  async function commitsBetween(from: string, to: string): Promise<Array<string | { more: number }>> {
    const commits = (await d.git(["log", "--first-parent", "--format=%h %s", `${from}..${to}`])).split("\n").filter(Boolean);
    return commits.length > MAX_CHANGES ? [...commits.slice(0, MAX_CHANGES), { more: commits.length - MAX_CHANGES }] : commits;
  }
  /** A deploy that did not happen, as a request: the commits `from..version` it concerns, none when `version` or `from` is not known or git cannot say. */
  async function failedPush(version: string | null, running: string | null, reason: string, from: string | null): Promise<Push> {
    const changes = version && from ? await commitsBetween(from, version).catch(() => []) : [];
    return { event: "deployFailed", version, running, reason, changes, repo: await repoName() };
  }
  /** A run that ends with nothing wrong (the board is current, or just deployed): a problem that comes back is news again. A run
   * that ends with another problem forgets nothing, or two problems that come and go in turn would be pushed every time. */
  function calm() { if (state.told) { delete state.told; save(); } }
  async function answers(ms: number) {
    const until = d.now() + ms;
    for (;;) {
      if (await d.healthy()) return true;
      if (d.now() >= until) return false;
      await d.sleep(1000);
    }
  }

  /** What a checkout needs to run: the packages when the lock file differs between the commits, and the page bundle always. */
  async function build(lockChanged: boolean) {
    if (lockChanged) await d.run("npm", ["ci"]);
    await d.run("npm", ["run", "-s", "build:web"]);
  }
  /** Restart the daemon and wait for it to answer from a new process: with `install`, by replacing its service file by that text
   * (and, for going back, the service file is the one `pending.config` kept), else by kickstart, which keeps the file launchd holds. */
  async function restartAndWait(pending: Pending, install?: string) {
    const before = await d.pid();
    // Recorded first: from the restart on, the daemon may run the target's code (and the new service file) whatever happens to this run.
    pending.restarted = true; save();
    if (install === undefined) await d.restart(); else await d.service!.replace(install);
    const deadline = d.now() + d.waitMs;
    while (d.now() < deadline) {
      const pid = await d.pid();
      if (pid !== undefined && pid !== before && await d.healthy()) {
        await d.sleep(d.stableMs);
        if (await d.pid() === pid && await d.healthy()) return;
      }
      await d.sleep(1000);
    }
    throw new Error(`the daemon was not healthy from one process within ${Math.round(d.waitMs / 1000)} s of the restart`);
  }

  /** Put the checkout, its packages and its page back on `pending.to`, with the daemon serving that code: restarted when it may
   * run the target's code or does not answer, left alone when the process that served before still answers. `thorough` installs the
   * packages whatever the lock file says: a rollback that failed part way may have left them half there. */
  async function goBack(pending: Pending, thorough: boolean) {
    pending.heads = [...new Set([...pending.heads, pending.to])]; save();
    // A deploy that moved no code has none to put back: it is the service file that goes back, below.
    if (!pending.inPlace) {
      await d.git(["reset", "--keep", pending.to]);
      pending.heads = [pending.to]; save();
      const differs = (await d.git(["diff", "--no-renames", "--name-only", pending.target, pending.to])).split("\n").includes("package-lock.json");
      await build(thorough || differs);
    }
    if (pending.restarted || !await answers(SETTLE_MS)) await restartAndWait(pending, pending.config);
  }
  /** The owner is told on the Mac: the board does not answer, and a board that does not answer cannot push. */
  async function alarm(message: string) {
    try { await d.notify("看板起不来", message); } catch (error) { d.log(`notify failed: ${reasonOf(error)}`); }
  }
  async function wentBack(pending: Pending, reason: string): Promise<DeployOutcome> {
    delete state.pending; state.healthy = pending.to; save();
    await tell(await failedPush(pending.target, pending.to, reason, pending.to));
    return "rolledBack";
  }
  /** Going back did not finish. Whether the daemon answers decides whether the owner is told on the Mac, since a daemon that does
   * not answer cannot push; either way the pending rollback stays, and the next run tries it again. */
  async function stuck(pending: Pending, reason: string, failure: unknown): Promise<DeployOutcome> {
    const serving = await answers(SETTLE_MS);
    const why = `${reason}; going back to ${pending.to} failed: ${reasonOf(failure)}; the daemon ${serving ? "still answers" : "is not answering"}, and the job tries again on its next run`;
    d.log(why);
    const news = await tellOnce("stuck", `${pending.target}:${serving}`, () => failedPush(pending.target, null, why, pending.to));
    if (news && !serving) await alarm(`部署 ${pending.target.slice(0, 7)} 失败，退回 ${pending.to.slice(0, 7)} 也没做完：${reasonOf(failure)}`);
    return serving ? "stuck" : "down";
  }
  /** Why the job must not go back on `pending`, or undefined when it may: it only undoes what it did to the checkout it moved. A
   * checkout that is on another branch, has local changes to tracked files, or is on a commit the job did not put it on has been
   * taken over by someone since (a deploy by hand, a branch made to look into something), even when that commit is the deploy's
   * target or the one to go back to. */
  async function takenOver(pending: Pending): Promise<string | undefined> {
    const branch = await d.git(["symbolic-ref", "--short", "HEAD"]).then(line, () => "");
    if (branch !== d.branch) return `it is on ${branch || "no branch"}, not ${d.branch}`;
    const head = line(await d.git(["rev-parse", "HEAD"]));
    if (!pending.heads.includes(head)) return `it is on ${head}, not where the job left it (${pending.heads.join(" or ")})`;
    if (line(await d.git(["status", "--porcelain", "--untracked-files=no", "--ignore-submodules"]))) return "it has local changes to tracked files";
  }
  async function recover(pending: Pending): Promise<DeployOutcome> {
    const failed = state.failed === pending.target;
    d.log(`finishing the ${failed ? "rollback" : "interrupted deploy"} of ${pending.target}: going back to ${pending.to}`);
    const reason = failed ? "the deploy failed on an earlier run" : "an earlier run was interrupted before the deploy finished";
    try { await goBack(pending, true); } catch (failure) { return stuck(pending, reason, failure); }
    return wentBack(pending, `${reason}; the checkout is back on ${pending.to}`);
  }

  /** Whether the checks on `target` let it go live: undefined when they all passed, else the outcome that ends the run. A commit goes
   * live only on green: one that is still running or has no checks yet is waited for, one with a red check is held (the board's own
   * look at the main line tells the session holding the item, so the job does not), and checks that cannot be read count as not green. */
  async function gate(target: string, head: string, running: string | null): Promise<DeployOutcome | undefined> {
    let checks: Checks;
    try {
      const repo = await repoName();
      if (!repo) throw new Error(`the address of ${d.remote} names no repository`);
      checks = await d.checks(repo, target);
    } catch (error) {
      d.log(`not deploying ${target}: its checks could not be read: ${reasonOf(error)}`);
      await tellOnce("checks", `read@${target}`, () => failedPush(target, running, `the checks of ${target} could not be read, so it was not deployed: ${reasonOf(error)}`, head));
      return "unchecked";
    }
    if (checks.state === "success") { if (state.waiting) { delete state.waiting; save(); } return undefined; }
    if (checks.state === "failure") {
      if (state.waiting) { delete state.waiting; save(); }
      d.log(`not deploying ${target}: its checks failed (${checks.failed.join(", ")}); it is looked at again on the next run`);
      return "held";
    }
    if (state.waiting?.commit !== target) { state.waiting = { commit: target, since: d.now() }; save(); }
    const minutes = Math.floor((d.now() - state.waiting.since) / 60_000);
    d.log(`waiting for the checks on ${target}: ${checks.state === "none" ? "none yet" : "not finished"}, ${minutes} min so far`);
    if (d.now() - state.waiting.since >= CHECKS_LATE_MS) {
      await tellOnce("checks", `late@${target}`, () => failedPush(target, running, `the checks of ${target} have not finished after ${minutes} minutes (${checks.state === "none" ? "none appeared" : "still running"}), so it is not deployed yet`, head));
    }
    return "waiting";
  }

  /** What the daemon's installed service file must become for `target`: the template of that commit, filled in with the values the
   * installed file holds (and the job's own home), when that renders to another text; undefined when it renders to the same text or no
   * file is installed. Throws when the installed file does not hold the values: a file the job cannot read is not one it may replace. */
  async function serviceChange(target: string): Promise<{ previous: string; next: string } | undefined> {
    const previous = await d.service?.installed();
    if (previous === undefined) return undefined;
    const next = renderPlist(await d.git(["show", `${target}:${SERVICE_TEMPLATE}`]), { ...installedValues(previous), HOME: d.service!.home });
    return next === previous ? undefined : { previous, next };
  }

  async function run(): Promise<DeployOutcome> {
    await flush();
    // A deploy or rollback left unfinished is finished first: nothing below may build on a checkout in an unknown state. When
    // someone has changed the checkout by hand since, it is theirs: nothing is reset or moved, the record is dropped, and the run
    // goes on from what the checkout holds now. The daemon not answering there is the one failure the job answers: the owner is told.
    if (state.pending) {
      const pending = state.pending, why = await takenOver(pending);
      if (why === undefined) return recover(pending);
      delete state.pending; save();
      const up = await answers(SETTLE_MS);
      d.log(`${pending.target} was unfinished and the checkout was changed by hand (${why}): taking over from what it holds`);
      await tell(await failedPush(pending.target, null, `the checkout was changed by hand while ${pending.target} was unfinished (${why}); the job took over from what it holds now and reset nothing`, pending.to));
      if (!up) await alarm(`检出被手动改过（${why}），看板没有答，部署任务没有动检出`);
    }

    const up = await answers(SETTLE_MS);
    const head = line(await d.git(["rev-parse", "HEAD"]));
    // A deploy that moves the checkout also ends or goes back (pending), so a daemon that answers serves what the checkout holds.
    if (up && state.healthy !== head) { state.healthy = head; save(); }
    // Where a failed deploy goes back to: what is serving, else what last did.
    const rollbackTo = up ? head : state.healthy ?? head;
    const running = up ? head : null;

    const ref = `${d.remote}/${d.branch}`;
    for (let attempt = 1; ; attempt++) {
      try { await d.network(["fetch", d.remote, `+refs/heads/${d.branch}:refs/remotes/${ref}`]); break; }
      catch (error) {
        if (attempt < FETCH_TRIES) { await d.sleep(d.fetchRetryMs); continue; }
        d.log(`fetch failed: ${reasonOf(error)}`);
        await tellOnce("fetch", "fetch", () => failedPush(null, running, `could not fetch ${ref}: ${reasonOf(error)}`, null));
        return "unreachable";
      }
    }
    const target = line(await d.git(["rev-parse", `refs/remotes/${ref}`]));
    // The template may have reached the checkout before the job could replace the file (a job that deploys its own code does so one run late).
    const service = await serviceChange(target);
    if (target === head && !service) { calm(); return "current"; }
    if (target === state.failed) { d.log(`${target} failed before; waiting for a newer commit`); return "skipped"; }

    // The refusals are about the checkout, not the commit: someone's edit or commit there is not ours to move or undo.
    async function refuse(id: string, reason: string): Promise<DeployOutcome> {
      d.log(`not deploying ${target}: ${reason}`);
      await tellOnce("refuse", `${id}@${target}`, () => failedPush(target, running, reason, head));
      return "refused";
    }
    const branch = await d.git(["symbolic-ref", "--short", "HEAD"]).then(line, () => "");
    if (branch !== d.branch) return refuse("branch", `the checkout is on ${branch || "no branch"}, not ${d.branch}`);
    const dirty = line(await d.git(["status", "--porcelain", "--untracked-files=no", "--ignore-submodules"]));
    if (dirty) return refuse("dirty", `the checkout has local changes to tracked files (${dirty.split("\n").slice(0, 5).join("; ")})`);
    const behind = await d.git(["merge-base", "--is-ancestor", head, target]).then(() => true, (error: { code?: number }) => { if (error.code === 1) return false; throw error; });
    if (!behind) return refuse("ahead", `the checkout's ${head} is not an ancestor of ${target}: it has commits the main line lacks`);

    // The code of the head is live already when only the service file differs: its checks passed when it went live.
    const inPlace = target === head && rollbackTo === head;
    if (target !== head) {
      const held = await gate(target, head, running);
      if (held) return held;
    }

    const changed = (await d.git(["diff", "--no-renames", "--name-only", head, target])).split("\n").filter(Boolean);
    const restart = !up || service !== undefined || changed.some(path => !NO_RESTART.some(entry => entry.endsWith("/") ? path.startsWith(entry) : path === entry));
    const changes = await commitsBetween(head, target);

    d.log(`deploying ${target} over ${head}${service ? ", replacing the service file" : restart ? ", restarting" : ", without a restart"}`);
    const pending: Pending = { target, to: rollbackTo, restarted: false, heads: [head, target] };
    if (inPlace) pending.inPlace = true;
    state.pending = pending; save();
    // A target is marked failed only once its code was in the checkout: a merge that git refused says nothing about the commit.
    let merged = false;
    try {
      if (!inPlace) {
        await d.git(["merge", "--ff-only", target]);
        merged = true; pending.heads = [target]; save();
        await build(changed.includes("package-lock.json"));
      } else merged = true;
      if (service) { pending.config = service.previous; await restartAndWait(pending, service.next); }
      else if (restart) await restartAndWait(pending);
      else if (!await answers(d.waitMs)) throw new Error("the daemon stopped answering");
    } catch (error) {
      const reason = reasonOf(error);
      d.log(`deploy of ${target} failed: ${reason}; going back to ${rollbackTo}`);
      if (merged) { state.failed = target; save(); }
      try { await goBack(pending, false); } catch (failure) { return stuck(pending, reason, failure); }
      return wentBack(pending, reason);
    }
    delete state.pending; delete state.failed; state.healthy = target; calm(); save();
    // Nothing was deployed that anyone waits to hear of: the code of the commit was live before.
    if (inPlace) { d.log(`the service file of ${target} was replaced and the daemon answers`); return "reconfigured"; }
    await tell({ event: "deployed", version: target, previous: head, changes, restarted: restart, repo: await repoName() });
    return "deployed";
  }

  try { return await run(); }
  catch (error) {
    // Whatever the job could not do, the architect hears of it once; it would otherwise stop deploying with only a log to show.
    d.log(`the deploy job failed: ${reasonOf(error)}`);
    await tellOnce("error", reasonOf(error), () => failedPush(null, null, `the deploy job itself failed: ${reasonOf(error)}`, null))
      .catch(failure => d.log(`could not tell: ${reasonOf(failure)}`));
    return "error";
  }
}
