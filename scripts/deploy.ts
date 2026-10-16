// One run of the deploy job; launchd starts it every five minutes (ops/wf-board-deploy.plist, installed by
// scripts/install-service.ts deploy). The logic is src/deploy.ts; this wires it to git, npm, launchctl, the daemon's HTTP port and
// the owner's notifications. It reads the checkout it lives in, so it deploys the checkout the daemon runs from.
// Environment (each with the live board's value as default): WF_BOARD_REPO (the checkout), WF_BOARD_PORT, WF_BOARD_LABEL (the daemon's launchd label),
// WF_BOARD_DEPLOY_STATE (the state file), WF_BOARD_DEPLOY_WAIT_MS and WF_BOARD_DEPLOY_STABLE_MS (the health wait),
// WF_BOARD_DEPLOY_NET_CAP_MS (the longest a fetch may run) and WF_BOARD_DEPLOY_FETCH_RETRY_MS (the wait between its tries); tests shorten them.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { deployOnce } from "../src/deploy.ts";
import type { DeployState } from "../src/deploy.ts";
import { macNotify } from "../src/notify.ts";
import { NET_GIT_CAP_MS, netGitOutput } from "../src/net-git.ts";

const env = process.env;
const repo = env.WF_BOARD_REPO ?? dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(env.WF_BOARD_PORT ?? 7417), label = env.WF_BOARD_LABEL ?? "org.ming-research.wf-board";
const stateFile = env.WF_BOARD_DEPLOY_STATE ?? join(homedir(), "Library/Application Support/wf-board/deploy.json");
const base = `http://127.0.0.1:${port}`;
// The node this job runs under is the last resort for finding npm, when the PATH launchd gives has none.
const childEnv = { ...env, PATH: `${env.PATH ?? "/usr/bin:/bin"}:${dirname(process.execPath)}` };

function exec(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repo, env: childEnv, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      // execFile's error carries the exit status as `code`; the message holds the command's own complaint.
      if (error) reject(Object.assign(new Error(`${command} ${args.join(" ")}: ${stderr.trim() || error.message}`), { code: (error as { code?: unknown }).code }));
      else resolve(stdout);
    });
  });
}

await deployOnce({
  branch: "main", remote: "origin",
  git: args => exec("git", args),
  // The fetch is the only thing the job asks of the network: bounded in time, and killed with its ssh (src/net-git.ts).
  network: args => netGitOutput(args, { cwd: repo, env: childEnv, capMs: Number(env.WF_BOARD_DEPLOY_NET_CAP_MS ?? NET_GIT_CAP_MS) }),
  run: async (command, args) => { await exec(command, args); },
  pid: async () => {
    const match = /"PID" = (\d+);/.exec(await exec("launchctl", ["list", label]).catch(() => ""));
    return match ? Number(match[1]) : undefined;
  },
  restart: async () => { await exec("launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/${label}`]); },
  healthy: async () => {
    try { const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }); return res.ok && ((await res.json()) as { ok?: unknown }).ok === true; }
    catch { return false; }
  },
  post: async push => {
    const res = await fetch(`${base}/api/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(push), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`POST /api/wake answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
  notify: macNotify(),
  load: () => {
    let text: string;
    try { text = readFileSync(stateFile, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { outbox: [] }; throw error; }
    try { return { outbox: [], ...(JSON.parse(text) as Partial<DeployState>) }; }
    catch (error) {
      // A file that does not parse would fail every run and nothing could say so: it is set aside and the job starts empty.
      console.error(`${new Date().toISOString()} state file unreadable, set aside: ${error instanceof Error ? error.message : error}`);
      renameSync(stateFile, `${stateFile}.corrupt`);
      return { outbox: [] };
    }
  },
  save: state => {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile + ".tmp", JSON.stringify(state, null, 2) + "\n"); renameSync(stateFile + ".tmp", stateFile);
  },
  sleep: ms => sleep(ms).then(() => {}),
  now: Date.now,
  log: message => console.info(`${new Date().toISOString()} ${message}`),
  waitMs: Number(env.WF_BOARD_DEPLOY_WAIT_MS ?? 90_000), stableMs: Number(env.WF_BOARD_DEPLOY_STABLE_MS ?? 5000),
  fetchRetryMs: Number(env.WF_BOARD_DEPLOY_FETCH_RETRY_MS ?? 10_000),
}).then(outcome => console.info(`${new Date().toISOString()} ${outcome}`));
