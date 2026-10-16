import type { Notify } from "./notify.ts";

/** The paths whose change needs no restart, the one place this is defined. The daemon loads src/ and the packages at its start and
 * reads nothing else of the checkout except the page files, which it reads from disk on each request (web/index.html and
 * web/dist/app.js, the bundle the deploy builds); test/deploy.test.ts guards both claims. A change to any other path, listed here
 * or not, restarts the daemon. */
export const NO_RESTART = ["docs/", "test/", "web/"];

/** A push to the architect, in the shape POST /api/wake takes: the kind (src/wake.ts, WAKE_KINDS) and its fields. */
export interface Push { event: "deployed" | "deployFailed"; [field: string]: unknown }

/** What the job keeps between runs, in a file beside no board data. */
export interface DeployState {
  /** The commit the board last served healthy: where a failed deploy goes back to when the board was already down. */
  healthy?: string;
  /** The commit whose deploy failed; it is not tried again, and a refusal is not repeated, until the remote moves on. */
  failed?: string;
  /** The refusal already pushed, as `<reason>@<target>`, so one standing reason is pushed once. */
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
  /** Tell the owner on the Mac (src/notify.ts): used only when the board cannot be brought back, so no daemon can push. */
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

export type DeployOutcome = "current" | "deployed" | "rolledBack" | "down" | "refused" | "skipped" | "unreachable";

/** The most commits one deploy push lists; the rest are counted. */
const MAX_CHANGES = 20;

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
  async function finish(outcome: DeployOutcome) { await flush(); return outcome; }

  const up = await d.healthy();
  await flush();
  const head = line(await d.git(["rev-parse", "HEAD"]));
  // Where a failed deploy goes back to: what was just serving, else what last did.
  const rollbackTo = up ? head : state.healthy ?? head;
  const running = up ? head : null;

  const branch = await d.git(["symbolic-ref", "--short", "HEAD"]).then(line, () => "");
  const ref = `${d.remote}/${d.branch}`;
  try { await d.git(["fetch", d.remote, `+refs/heads/${d.branch}:refs/remotes/${ref}`]); }
  catch (error) { d.log(`fetch failed: ${reasonOf(error)}`); return finish("unreachable"); }
  const target = line(await d.git(["rev-parse", `refs/remotes/${ref}`]));
  if (target === head) return finish("current");
  if (target === state.failed) { d.log(`${target} failed before; waiting for a newer commit`); return finish("skipped"); }

  // The refusals are about the checkout, not the commit: someone's edit or commit there is not ours to move or undo.
  async function refuse(id: string, reason: string): Promise<DeployOutcome> {
    d.log(`not deploying ${target}: ${reason}`);
    const key = `${id}@${target}`;
    if (state.told !== key) { state.told = key; await tell({ event: "deployFailed", version: target, running, reason }); }
    return finish("refused");
  }
  if (branch !== d.branch) return refuse("branch", `the checkout is on ${branch || "no branch"}, not ${d.branch}`);
  const dirty = line(await d.git(["status", "--porcelain", "--untracked-files=no"]));
  if (dirty) return refuse("dirty", `the checkout has local changes to tracked files (${dirty.split("\n").slice(0, 5).join("; ")})`);
  const behind = await d.git(["merge-base", "--is-ancestor", head, target]).then(() => true, (error: { code?: number }) => { if (error.code === 1) return false; throw error; });
  if (!behind) return refuse("ahead", `the checkout's ${head} is not an ancestor of ${target}: it has commits the main line lacks`);

  const changed = (await d.git(["diff", "--no-renames", "--name-only", head, target])).split("\n").filter(Boolean);
  const restart = !up || changed.some(path => !NO_RESTART.some(prefix => path.startsWith(prefix)));
  const commits = (await d.git(["log", "--first-parent", "--format=%h %s", `${head}..${target}`])).split("\n").filter(Boolean);
  const changes = commits.length > MAX_CHANGES ? [...commits.slice(0, MAX_CHANGES), { more: commits.length - MAX_CHANGES }] : commits;

  /** What a checkout needs to run: the packages when the lock file differs between the commits, and the page bundle always. */
  async function build(lockChanged: boolean) {
    if (lockChanged) await d.run("npm", ["ci"]);
    await d.run("npm", ["run", "-s", "build:web"]);
  }
  async function restartAndWait() {
    const before = await d.pid();
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

  d.log(`deploying ${target} over ${head}${restart ? ", restarting" : ", without a restart"}`);
  try {
    await d.git(["merge", "--ff-only", target]);
    await build(changed.includes("package-lock.json"));
    if (restart) await restartAndWait(); else if (!await d.healthy()) throw new Error("the daemon stopped answering");
  } catch (error) {
    const reason = reasonOf(error);
    d.log(`deploy of ${target} failed: ${reason}; going back to ${rollbackTo}`);
    state.failed = target; save();
    try {
      // The code goes back and so does what is built from it: a new bundle left over an old daemon is a half deploy.
      await d.git(["reset", "--keep", rollbackTo]);
      const back = (await d.git(["diff", "--no-renames", "--name-only", target, rollbackTo])).split("\n");
      await build(back.includes("package-lock.json"));
      if (restart) await restartAndWait(); else if (!await d.healthy()) throw new Error("the daemon stopped answering");
    } catch (failure) {
      d.log(`going back to ${rollbackTo} failed too: ${reasonOf(failure)}`);
      await tell({ event: "deployFailed", version: target, running: null, reason: `${reason}; going back to ${rollbackTo} failed too: ${reasonOf(failure)}` });
      try { await d.notify("看板起不来", `部署 ${target.slice(0, 7)} 失败，退回 ${rollbackTo.slice(0, 7)} 也失败：${reasonOf(failure)}`); } catch (e) { d.log(`notify failed: ${reasonOf(e)}`); }
      return "down";
    }
    state.healthy = rollbackTo; save();
    await tell({ event: "deployFailed", version: target, running: rollbackTo, reason });
    return "rolledBack";
  }
  state.healthy = target; delete state.failed; delete state.told; save();
  await tell({ event: "deployed", version: target, previous: head, changes, restarted: restart });
  return "deployed";
}
