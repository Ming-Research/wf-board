import type { Notify } from "./notify.ts";

/** The paths whose change needs no restart, the one place this is defined. The daemon loads src/ and the packages at its start and
 * reads nothing else of the checkout except the page files, which it reads from disk on each request (web/index.html and
 * web/dist/app.js, the bundle the deploy builds); test/deploy.test.ts guards both claims. A change to any other path, listed here
 * or not, restarts the daemon. */
export const NO_RESTART = ["docs/", "test/", "web/"];

/** A push to the architect, in the shape POST /api/wake takes: the kind (src/wake.ts, WAKE_KINDS) and its fields. */
export interface Push { event: "deployed" | "deployFailed"; [field: string]: unknown }

/** A deploy that began and did not end, or a rollback that did not finish: the commit to go back to. The next run finishes it
 * before it does anything else, so a failure part way is never left as the new state of the checkout. */
export interface Pending {
  /** The commit being deployed. */
  target: string;
  /** The last healthy commit: where the checkout, its packages, its page and the daemon go back to. */
  to: string;
  /** A restart was begun for this deploy, so the daemon may run the target's code. */
  restarted: boolean;
}

/** What the job keeps between runs, in a file beside no board data. */
export interface DeployState {
  /** The commit the board last served healthy: where a failed deploy goes back to when the board was already down. */
  healthy?: string;
  /** The commit whose deploy failed; it is not tried again until the remote moves on. */
  failed?: string;
  pending?: Pending;
  /** The standing problem already pushed, so it is pushed once; a run that finds nothing wrong forgets it. */
  told?: string;
  /** Pushes the daemon did not take (it was down), sent first on the next run. */
  outbox: Push[];
}

export interface DeployDeps {
  branch: string;
  remote: string;
  /** git in the checkout; rejects with the exit status as `code` when git fails. */
  git(args: string[]): Promise<string>;
  /** A command of the deploy (npm) in the checkout; rejects when it fails. */
  run(command: string, args: string[]): Promise<void>;
  /** The pid launchd reports for the daemon, or undefined while it is not running. */
  pid(): Promise<number | undefined>;
  /** launchctl kickstart -k on the daemon's own label: it restarts that service and nothing else. */
  restart(): Promise<void>;
  /** Whether /health answers. */
  healthy(): Promise<boolean>;
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
}

/** `stuck`: going back did not finish but the daemon answers; `down`: it does not answer either; `error`: the job itself failed. */
export type DeployOutcome = "current" | "deployed" | "rolledBack" | "stuck" | "down" | "refused" | "skipped" | "unreachable" | "error";

/** The most commits one deploy push lists; the rest are counted. */
const MAX_CHANGES = 20;
/** How long a probe of /health keeps trying before it says the daemon does not answer: one probe can miss a daemon that is busy or just starting. */
const SETTLE_MS = 15_000;
/** A fetch is tried this often, this far apart, before the remote counts as unreachable: a network that has just come back needs a moment. */
const FETCH_TRIES = 3, FETCH_RETRY_MS = 10_000;

const line = (text: string) => text.trim();
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim().split("\n").slice(0, 3).join(" ").slice(0, 300);

/** One run of the deploy job: move the checkout to the main line's head and restart the daemon on it when that is needed, go back to
 * the last healthy commit when the daemon does not come up, and tell the architect either way (docs/design.md, Running). */
export async function deployOnce(d: DeployDeps): Promise<DeployOutcome> {
  const state = d.load();
  const save = () => d.save(state);
  async function flush() {
    while (state.outbox.length) {
      try { await d.post(state.outbox[0]!); } catch (error) { d.log(`push not taken, kept for the next run: ${reasonOf(error)}`); return; }
      state.outbox.shift(); save();
    }
  }
  async function tell(push: Push) { state.outbox.push(push); save(); await flush(); }
  /** Push a standing problem once: `key` names it, and `calm` forgets it. */
  async function tellOnce(key: string, push: Push) { if (state.told === key) return; state.told = key; await tell(push); }
  function calm() { if (state.told !== undefined) { delete state.told; save(); } }
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
  async function restartAndWait(pending: Pending) {
    const before = await d.pid();
    // Recorded first: from the kickstart on, the daemon may run the target's code whatever happens to this run.
    pending.restarted = true; save();
    await d.restart();
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
    await d.git(["reset", "--keep", pending.to]);
    const differs = (await d.git(["diff", "--no-renames", "--name-only", pending.target, pending.to])).split("\n").includes("package-lock.json");
    await build(thorough || differs);
    if (pending.restarted || !await answers(SETTLE_MS)) await restartAndWait(pending);
  }
  async function wentBack(pending: Pending, reason: string): Promise<DeployOutcome> {
    delete state.pending; state.healthy = pending.to; save();
    await tell({ event: "deployFailed", version: pending.target, running: pending.to, reason });
    return "rolledBack";
  }
  /** Going back did not finish. Whether the daemon answers decides whether the owner is told on the Mac, since a daemon that does
   * not answer cannot push; either way the pending rollback stays, and the next run tries it again. */
  async function stuck(pending: Pending, reason: string, failure: unknown): Promise<DeployOutcome> {
    const serving = await answers(SETTLE_MS);
    const why = `${reason}; going back to ${pending.to} failed: ${reasonOf(failure)}; the daemon ${serving ? "still answers" : "is not answering"}, and the job tries again on its next run`;
    d.log(why);
    const key = `stuck@${pending.target}:${serving}`;
    if (state.told !== key) {
      await tellOnce(key, { event: "deployFailed", version: pending.target, running: null, reason: why });
      if (!serving) {
        try { await d.notify("看板起不来", `部署 ${pending.target.slice(0, 7)} 失败，退回 ${pending.to.slice(0, 7)} 也没做完：${reasonOf(failure)}`); }
        catch (error) { d.log(`notify failed: ${reasonOf(error)}`); }
      }
    }
    return serving ? "stuck" : "down";
  }
  async function recover(pending: Pending): Promise<DeployOutcome> {
    const failed = state.failed === pending.target;
    d.log(`finishing the ${failed ? "rollback" : "interrupted deploy"} of ${pending.target}: going back to ${pending.to}`);
    const reason = failed ? "the deploy failed on an earlier run" : "an earlier run was interrupted before the deploy finished";
    try { await goBack(pending, true); } catch (failure) { return stuck(pending, reason, failure); }
    return wentBack(pending, `${reason}; the checkout is back on ${pending.to}`);
  }

  async function run(): Promise<DeployOutcome> {
    await flush();
    // A deploy or rollback left unfinished is finished first: nothing below may build on a checkout in an unknown state.
    if (state.pending) return recover(state.pending);

    const up = await answers(SETTLE_MS);
    const head = line(await d.git(["rev-parse", "HEAD"]));
    // A deploy that moves the checkout also ends or goes back (pending), so a daemon that answers serves what the checkout holds.
    if (up && state.healthy !== head) { state.healthy = head; save(); }
    // Where a failed deploy goes back to: what is serving, else what last did.
    const rollbackTo = up ? head : state.healthy ?? head;
    const running = up ? head : null;

    const ref = `${d.remote}/${d.branch}`;
    for (let attempt = 1; ; attempt++) {
      try { await d.git(["fetch", d.remote, `+refs/heads/${d.branch}:refs/remotes/${ref}`]); break; }
      catch (error) {
        if (attempt < FETCH_TRIES) { await d.sleep(FETCH_RETRY_MS); continue; }
        d.log(`fetch failed: ${reasonOf(error)}`);
        await tellOnce("fetch", { event: "deployFailed", version: null, running, reason: `could not fetch ${ref}: ${reasonOf(error)}` });
        return "unreachable";
      }
    }
    const target = line(await d.git(["rev-parse", `refs/remotes/${ref}`]));
    if (target === head) { calm(); return "current"; }
    if (target === state.failed) { d.log(`${target} failed before; waiting for a newer commit`); return "skipped"; }

    // The refusals are about the checkout, not the commit: someone's edit or commit there is not ours to move or undo.
    async function refuse(id: string, reason: string): Promise<DeployOutcome> {
      d.log(`not deploying ${target}: ${reason}`);
      await tellOnce(`${id}@${target}`, { event: "deployFailed", version: target, running, reason });
      return "refused";
    }
    const branch = await d.git(["symbolic-ref", "--short", "HEAD"]).then(line, () => "");
    if (branch !== d.branch) return refuse("branch", `the checkout is on ${branch || "no branch"}, not ${d.branch}`);
    const dirty = line(await d.git(["status", "--porcelain", "--untracked-files=no"]));
    if (dirty) return refuse("dirty", `the checkout has local changes to tracked files (${dirty.split("\n").slice(0, 5).join("; ")})`);
    const behind = await d.git(["merge-base", "--is-ancestor", head, target]).then(() => true, (error: { code?: number }) => { if (error.code === 1) return false; throw error; });
    if (!behind) return refuse("ahead", `the checkout's ${head} is not an ancestor of ${target}: it has commits the main line lacks`);

    const changed = (await d.git(["diff", "--no-renames", "--name-only", head, target])).split("\n").filter(Boolean);
    const restart = !up || changed.some(path => !NO_RESTART.some(prefix => path.startsWith(prefix)));
    const commits = (await d.git(["log", "--first-parent", "--format=%h %s", `${head}..${target}`])).split("\n").filter(Boolean);
    const changes = commits.length > MAX_CHANGES ? [...commits.slice(0, MAX_CHANGES), { more: commits.length - MAX_CHANGES }] : commits;

    d.log(`deploying ${target} over ${head}${restart ? ", restarting" : ", without a restart"}`);
    const pending: Pending = { target, to: rollbackTo, restarted: false };
    state.pending = pending; save();
    // A target is marked failed only once its code was in the checkout: a merge that git refused says nothing about the commit.
    let merged = false;
    try {
      await d.git(["merge", "--ff-only", target]);
      merged = true;
      await build(changed.includes("package-lock.json"));
      if (restart) await restartAndWait(pending);
      else if (!await answers(d.waitMs)) throw new Error("the daemon stopped answering");
    } catch (error) {
      const reason = reasonOf(error);
      d.log(`deploy of ${target} failed: ${reason}; going back to ${rollbackTo}`);
      if (merged) { state.failed = target; save(); }
      try { await goBack(pending, false); } catch (failure) { return stuck(pending, reason, failure); }
      return wentBack(pending, reason);
    }
    delete state.pending; delete state.failed; delete state.told; state.healthy = target; save();
    await tell({ event: "deployed", version: target, previous: head, changes, restarted: restart });
    return "deployed";
  }

  try { return await run(); }
  catch (error) {
    // Whatever the job could not do, the architect hears of it once; it would otherwise stop deploying with only a log to show.
    d.log(`the deploy job failed: ${reasonOf(error)}`);
    await tellOnce(`error@${reasonOf(error)}`, { event: "deployFailed", version: null, running: null, reason: `the deploy job itself failed: ${reasonOf(error)}` })
      .catch(failure => d.log(`could not tell: ${reasonOf(failure)}`));
    return "error";
  }
}
