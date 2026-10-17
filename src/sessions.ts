import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** One session as `claude agents --json --all` lists it: the fields the sessions watch reads (docs/design.md, The wake streams, Sessions watch). */
export interface SessionRow {
  /** The short id `claude stop` and `claude attach` take; empty for an interactive session, which has none. */
  id: string;
  sessionId: string;
  name: string;
  kind: "background" | "interactive";
  cwd: string;
  /** The process id; none when the session's process has ended (stopped, finished and retired, or crashed). */
  pid: number | undefined;
  /** busy, idle or waiting while the process runs; none without one. */
  status: string | undefined;
  /** working, blocked, done, failed or stopped: background sessions only. */
  state: string | undefined;
  waitingFor: string | undefined;
}

const str = (v: unknown): string | undefined => typeof v === "string" && v !== "" ? v : undefined;

/** The sessions in the output of `claude agents --json --all`. A row without a name or a session id is left out: nothing could say
 * which session it is. Throws when the text is not a list. */
export function parseSessions(text: string): SessionRow[] {
  const list: unknown = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error("claude agents --json did not print a list");
  const rows: SessionRow[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>, name = str(e.name), sessionId = str(e.sessionId);
    if (name === undefined || sessionId === undefined) continue;
    rows.push({
      id: str(e.id) ?? "", sessionId, name, kind: e.kind === "interactive" ? "interactive" : "background", cwd: str(e.cwd) ?? "",
      pid: typeof e.pid === "number" ? e.pid : undefined, status: str(e.status), state: str(e.state), waitingFor: str(e.waitingFor),
    });
  }
  return rows;
}

/** How the watch reaches Claude Code: the one place that runs `claude`, so tests can put a fake in its place. */
export interface Claude {
  sessions(): Promise<SessionRow[]>;
  /** What the session wrote about what it needs, for the PM to read; none when it wrote nothing or the file cannot be read. */
  needs(row: SessionRow): Promise<string | undefined>;
  /** `claude stop`: the session's process ends, its conversation stays. Rejects when the command fails. */
  stop(row: SessionRow): Promise<void>;
  /** `claude --bg --resume <session id> -- <prompt>` in the session's directory: continues the session under the same id, or starts
   * a copy under another. Resolves with the row claude lists for what it started, none when it lists no such row. */
  resume(row: SessionRow, prompt: string): Promise<SessionRow | undefined>;
}

export interface ClaudeOptions {
  /** The `claude` command: its path, since the daemon's PATH is the service's. */
  command: string;
  /** The wf workspace; every session started or resumed gets it as WF_HOME, as pm/agent.mjs does. */
  home: string;
  /** Where Claude Code keeps its state; default ~/.claude. */
  claudeHome?: string;
  /** The longest one command may run; default 60 seconds. */
  timeoutMs?: number;
  /** Milliseconds between the looks for a resumed session's process, and how many looks; tests make them short. */
  lookMs?: number;
  looks?: number;
  /** What keeps the Mac awake while a resumed session's process runs; tests replace it. */
  keepAwake?: (pid: number) => void;
}

function run(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: opts.cwd || undefined, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.slice(0, 3).join(" ")}: ${(stderr || stdout || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/** Keeps the Mac awake while a process runs, as pm/agent.mjs does for the sessions it starts (`caffeinate -s -w`: on AC power only,
 * and it ends with the process). A machine without caffeinate is only logged. */
function keepAwake(pid: number): void {
  const child = spawn("caffeinate", ["-s", "-w", String(pid)], { detached: true, stdio: "ignore" });
  child.on("error", error => console.error(`caffeinate: ${error.message}`));
  child.unref();
}

/** The `claude` command of this machine. Stop and resume are the sequence pm/agent.mjs `resume` uses; the watch checks the result. */
export function realClaude(opts: ClaudeOptions): Claude {
  const timeoutMs = opts.timeoutMs ?? 60_000, claudeHome = opts.claudeHome ?? join(homedir(), ".claude");
  const lookMs = opts.lookMs ?? 1000, looks = opts.looks ?? 10, awake = opts.keepAwake ?? keepAwake;
  const claude = (args: string[], cwd?: string, extra?: NodeJS.ProcessEnv) => run(opts.command, args, { cwd, env: extra && { ...process.env, ...extra }, timeoutMs });
  const sessions = async () => parseSessions(await claude(["agents", "--json", "--all"]));
  return {
    sessions,
    async needs(row) {
      try {
        const state = JSON.parse(await readFile(join(claudeHome, "jobs", row.id, "state.json"), "utf8")) as { needs?: unknown; detail?: unknown };
        const text = str(state.needs) ?? str(state.detail);
        return text === undefined ? undefined : [...text].slice(0, 160).join("");
      } catch { return undefined; }
    },
    async stop(row) { await claude(["stop", row.id]); },
    async resume(row, prompt) {
      const out = await claude(["--bg", "--resume", row.sessionId, "--", prompt], row.cwd, { WF_HOME: opts.home });
      const printed = /^backgrounded · ([0-9a-f]{8}) · /m.exec(out)?.[1];
      if (printed === undefined) throw new Error(`claude did not report a started session for ${row.name}: ${out.trim().slice(0, 200)}`);
      // claude lists a new session's process a moment after it starts: look again each second, ten times at most.
      let found: SessionRow | undefined;
      for (let look = 0; look < looks; look += 1) {
        found = (await sessions().catch(() => [])).find(s => s.id === printed);
        if (found?.pid !== undefined) break;
        await new Promise(done => setTimeout(done, lookMs));
      }
      if (found?.pid !== undefined) awake(found.pid);
      return found;
    },
  };
}
