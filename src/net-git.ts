import { spawn } from "node:child_process";

/** The longest a git command that reaches a remote may run: past it the command and everything it started are killed. It is
 * shorter than the push interval (10 minutes), so a stuck push always ends before the next one is due, and longer than a large
 * catch-up push needs. Provisional: reopen it when the service log shows a push killed by the cap while it was still sending. */
export const NET_GIT_CAP_MS = 5 * 60_000;
/** How long a command that was sent SIGTERM has to end before its whole process group is sent SIGKILL. */
export const NET_GIT_KILL_GRACE_MS = 2000;
/** The most output kept of one command; git's own reports of a fetch or push are far smaller. */
const MAX_OUTPUT = 1024 * 1024;

export interface NetGitOptions {
  cwd: string;
  /** Ends the command: the process group gets SIGTERM, and SIGKILL after the grace. */
  signal?: AbortSignal;
  /** Overrides the cap and the grace; for tests that cannot wait minutes. */
  capMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface NetGitResult {
  /** The exit status, or null when a signal ended git. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why the command was killed, when it was: the cap or the caller's signal. */
  killedBy?: "cap" | "signal";
}

/** Runs a git command that reaches a remote: the only way the board runs one (docs/design.md, Storage). Nothing here may wait
 * for the network without a limit, so the command starts in a process group of its own and the group, ssh included, is killed
 * when the cap is reached or `signal` aborts (killing git alone leaves its ssh child running). Git's automatic maintenance is
 * off, so the command never starts a background repack beside the board's writes. Resolves with the exit status however git
 * ended; rejects only when git could not be started. */
export function netGit(args: string[], opts: NetGitOptions): Promise<NetGitResult> {
  const capMs = opts.capMs ?? NET_GIT_CAP_MS, graceMs = opts.killGraceMs ?? NET_GIT_KILL_GRACE_MS;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { resolve({ code: null, stdout: "", stderr: "", killedBy: "signal" }); return; }
    const child = spawn("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
      cwd: opts.cwd, env: opts.env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const pgid = child.pid;
    let stdout = "", stderr = "", killedBy: NetGitResult["killedBy"], hardKill: ReturnType<typeof setTimeout> | undefined;
    const take = (into: "stdout" | "stderr") => (chunk: Buffer) => {
      if (into === "stdout") stdout = (stdout + chunk.toString("utf8")).slice(-MAX_OUTPUT);
      else stderr = (stderr + chunk.toString("utf8")).slice(-MAX_OUTPUT);
    };
    child.stdout.on("data", take("stdout")); child.stderr.on("data", take("stderr"));
    const killGroup = (signal: NodeJS.Signals) => { try { if (pgid !== undefined) process.kill(-pgid, signal); } catch { /* the group is already gone */ } };
    const stop = (why: "cap" | "signal") => {
      if (killedBy) return;
      killedBy = why;
      killGroup("SIGTERM");
      hardKill = setTimeout(() => killGroup("SIGKILL"), graceMs);
    };
    const cap = setTimeout(() => stop("cap"), capMs);
    const onAbort = () => stop("signal");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => { clearTimeout(cap); clearTimeout(hardKill); opts.signal?.removeEventListener("abort", onAbort); };
    child.on("error", error => { done(); reject(error); });
    // "close" and not "exit": the output pipes are shared with ssh, so a stray ssh holds the command open until the cap ends it.
    child.on("close", code => { done(); resolve({ code, stdout, stderr, ...(killedBy ? { killedBy } : {}) }); });
  });
}

/** What a failed or killed command says, in one line: git's own complaint, or why it was killed. */
export function netGitReason(result: NetGitResult, capMs = NET_GIT_CAP_MS): string {
  if (result.killedBy === "cap") return `killed by the cap after ${Math.round(capMs / 1000)} s`;
  if (result.killedBy === "signal") return "stopped on request";
  return (result.stderr.trim() || result.stdout.trim() || `git exited with ${result.code}`).split("\n").slice(0, 3).join(" ").slice(0, 300);
}

/** The same, for a caller that wants git's output or a rejection: the error names the command and why it failed, and carries the
 * exit status as `code` like the other git calls of the deploy job. */
export async function netGitOutput(args: string[], opts: NetGitOptions): Promise<string> {
  const result = await netGit(args, opts);
  if (result.code === 0) return result.stdout;
  throw Object.assign(new Error(`git ${args.join(" ")}: ${netGitReason(result, opts.capMs)}`), { code: result.code });
}
