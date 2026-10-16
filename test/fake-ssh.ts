import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A stand-in for ssh that needs no server: git runs it as `fake-ssh host "git-receive-pack '<path>'"`, and it runs that command on
 * this machine. Each connection leaves a file named for its process id holding the remote command, so a test counts connections
 * and finds the ones still alive. What a connection does is set by files in the same directory, read when the connection opens:
 * `delay` (seconds to wait before running the command), `stall` (never answer; its text is a part of the command to stall on,
 * empty for every command) and `stubborn` (never answer, and ignore SIGTERM). */
const SCRIPT = `#!/bin/sh
for last; do :; done
echo "$last" > "$FAKE_SSH_DIR/conn.$$"
if [ -f "$FAKE_SSH_DIR/stubborn" ]; then
  trap '' TERM
  while true; do sleep 1; done
fi
if [ -f "$FAKE_SSH_DIR/stall" ]; then
  case "$last" in *"$(cat "$FAKE_SSH_DIR/stall")"*) exec sleep 3600 ;; esac
fi
[ -f "$FAKE_SSH_DIR/delay" ] && sleep "$(cat "$FAKE_SSH_DIR/delay")"
exec sh -c "$last"
`;

export async function fakeSsh(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-fake-ssh-"));
  const script = join(dir, "fake-ssh.sh"), control = join(dir, "control");
  await mkdir(control);
  await writeFile(script, SCRIPT); await chmod(script, 0o755);
  /** The environment that makes git use this ssh. `simple` tells git the wrapper is not OpenSSH, or it runs it with -G first. */
  const env = { GIT_SSH_COMMAND: script, FAKE_SSH_DIR: control, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "ssh.variant", GIT_CONFIG_VALUE_0: "simple" };
  const connections = async () => (await readdir(control)).filter(name => name.startsWith("conn.")).map(name => Number(name.slice(5)));
  const alive = async (pid: number) => {
    const state = await exec("ps", ["-o", "stat=", "-p", String(pid)]).then(r => r.stdout.trim(), () => "");
    return state !== "" && !state.startsWith("Z");
  };
  const fake = {
    env, dir,
    /** The url of a repository on this machine, reached through the fake ssh. */
    url: (path: string) => `ssh://fake${path}`,
    set: (name: "delay" | "stall" | "stubborn", text = "") => writeFile(join(control, name), text),
    clear: (name: "delay" | "stall" | "stubborn") => rm(join(control, name), { force: true }),
    /** How many connections were opened so far. */
    connections: async () => (await connections()).length,
    /** The connections still running: after a push was killed there are none. */
    alive: async () => { const pids = await connections(); return (await Promise.all(pids.map(async pid => await alive(pid) ? pid : 0))).filter(Boolean); },
    /** Waits until a connection has opened, which is when git has begun to talk to the remote. */
    async opened(count = 1, ms = 10_000) {
      for (let waited = 0; (await fake.connections()) < count; waited += 20) {
        if (waited >= ms) throw new Error(`no connection opened within ${ms} ms`);
        await sleep(20);
      }
    },
    /** Waits until no connection is alive, for a process that was just killed and is still being reaped. */
    async gone(ms = 3000) {
      for (let waited = 0; ; waited += 20) {
        const left = await fake.alive();
        if (!left.length) return;
        if (waited >= ms) throw new Error(`connections still alive after ${ms} ms: ${left.join(", ")}`);
        await sleep(20);
      }
    },
  };
  t.after(async () => {
    // A connection a failed test left behind must not outlive it.
    for (const pid of await fake.alive()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return fake;
}
