import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { holderOf, holders, openDispatches } from "./dispatch.ts";
import { PM_SESSION } from "./model.ts";
import type { Snapshot } from "./model.ts";
import { isReviewStep, reviewRequested } from "./rules.ts";
import type { Rules } from "./rules.ts";
import type { Claude, SessionRow } from "./sessions.ts";
import { STUCK_WHY } from "./wake.ts";
import type { Mail, StuckWhy, Wake } from "./wake.ts";
import type { Store } from "./store.ts";

/** The sessions watch (docs/design.md, The wake streams, Sessions watch): once a round the board reads the sessions that hold items,
 * review them, or are the PM, wakes the ones that are parked with pushes undelivered, and tells the PM of the ones that are stuck.
 * The timings are provisional; the design gives the grounds for each and when to reopen it. */
export const ROUND_MS = 30_000;
/** A session counts as parked once it has looked parked for this long: a round has passed, so its row was read twice. */
export const QUIET_MS = 20_000;
/** A session blocked, or the PM's, is told this long after the board first saw it blocked. */
export const BLOCKED_AFTER_MS = 2 * 60_000;
/** A parked engineer whose item has work and waits on nothing is woken once this long after it parked; if it parks again as long
 * without the plan saying what it waits on, the PM is told. */
export const WORK_AFTER_MS = 5 * 60_000;
/** A review in progress whose reviewer and engineer have both been parked this long, with no push on the way, is told as a stuck link. */
export const CHAIN_AFTER_MS = 15 * 60_000;
/** A busy session whose oldest undelivered push is this old is told: the push waits behind a command that does not end. */
export const UNREAD_AFTER_MS = 20 * 60_000;
/** Failed wakes of one session before the PM is told, and how long after a failure before the next try. */
export const WAKE_FAILURES = 3;
export const RETRY_AFTER_MS = 10 * 60_000;

/** Where a session is, from its row in `claude agents --json`. `busy` covers a turn running and a turn ended with a command still
 * running (the row cannot tell them apart); `unknown` is a status this code has no word for, and is left alone. */
export type Phase = "gone" | "busy" | "idle" | "blocked" | "unknown";
export function phaseOf(row: SessionRow): Phase {
  if (row.pid === undefined) return "gone";
  if (row.status === "waiting") return "blocked";
  if (row.status === "busy") return "busy";
  if (row.status === "idle") return row.state === "blocked" ? "blocked" : "idle";
  return "unknown";
}

export type Role = "engineer" | "reviewer" | "pm";
/** A session the board looks after: the items an engineer holds, the items a reviewer reviews, none for the PM. */
export interface Watched { name: string; role: Role; items: string[] }

/** The sessions to look after: engineers holding an open item that is not paused, reviewers with an open review record on such an
 * item, and the PM. A session of a paused, done or cancelled item is waiting or finished, and is the PM's to stop or resume. */
export function watched(s: Snapshot, r: Rules): Watched[] {
  const live = (item: string) => r.isOpenWork(item) && !r.isPaused(item);
  const out = new Map<string, Watched>();
  for (const [name, items] of holders(s, live)) out.set(name, { name, role: "engineer", items });
  for (const item of Object.keys(s.items)) {
    if (!live(item)) continue;
    for (const d of openDispatches(s, item)) {
      if (d.role !== "审查") continue;
      const known = out.get(d.agent);
      if (known?.role === "reviewer") known.items.push(item);
      else if (!known) out.set(d.agent, { name: d.agent, role: "reviewer", items: [item] });
    }
  }
  out.set(PM_SESSION, { name: PM_SESSION, role: "pm", items: [] });
  return [...out.values()];
}

/** Whether the item waits on something the session cannot hurry: it is blocked on a card or another item, a step in progress names
 * what it waits on (CI, a 14900K run), its review or CI step is in progress, or the merge is done and the live check is not (the
 * deploy's push comes). A session may rest then; the board does not call that stopped. */
export function awaitsElsewhere(s: Snapshot, r: Rules, item: string): boolean {
  if (r.statusOf(item) === "blocked") return true;
  const plan = s.items[item]?.plan ?? [];
  if (plan.some(row => "text" in row && row.state === "doing" && (row.waits !== undefined || isReviewStep(row) || row.id === "ci"))) return true;
  const state = (id: string) => { const row = plan.find(x => "text" in x && x.id === id); return row && "text" in row ? row.state : undefined; };
  const live = state("verify");
  return state("merge") === "done" && live !== undefined && live !== "done" && live !== "dropped";
}

/** Whether the item has work for a session to do: it is in progress, can be started, or has begun with nothing in progress. */
export function hasWorkLeft(r: Rules, item: string): boolean {
  const status = r.statusOf(item);
  return status === "wip" || status === "todo" || status === "idle";
}

/** What the board remembers of one session between rounds. Everything but `busyAt` is kept in a file, so a restart (every merge brings one) neither
 * forgets how long a session has been parked nor tells the PM of a stuck session again. */
interface Track {
  /** Since when the session has looked parked (idle, or without a process); unset while it is busy, and after a wake. */
  parkedSince?: number;
  /** Since when it has looked blocked. */
  blockedSince?: number;
  /** When the "work is left" wake was made; kept until the item has no work left or waits on something. */
  workWoken?: number;
  /** Failed wakes in a row, and when the last try was made. */
  failures: number;
  lastTry?: number;
  /** The stuck reports made, by `why`, with their time; one is cleared when the situation it names no longer holds, so it is told once. */
  told: Record<string, number>;
}

export interface SessionWatchOptions {
  store: Pick<Store, "snapshot" | "derived">;
  wake: Wake;
  claude: Claude;
  now?: () => number;
  /** Where the tracks are kept (git leaves it out); without it they live in memory only. */
  file?: string;
  intervalMs?: number;
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

export class SessionWatch {
  private readonly store: SessionWatchOptions["store"];
  private readonly wake: Wake;
  private readonly claude: Claude;
  private readonly now: () => number;
  private readonly file?: string;
  private readonly intervalMs: number;
  private readonly tracks = new Map<string, Track>();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private saved = "";

  constructor(options: SessionWatchOptions) {
    this.store = options.store; this.wake = options.wake; this.claude = options.claude;
    this.now = options.now ?? Date.now; this.file = options.file; this.intervalMs = options.intervalMs ?? ROUND_MS;
    this.load();
  }

  start(): void {
    this.timer = setInterval(() => { void this.round().catch(error => console.error("sessions watch", error)); }, this.intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private load(): void {
    if (!this.file) return;
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8")) as { sessions?: Record<string, Partial<Track>> };
      for (const [name, t] of Object.entries(doc.sessions ?? {})) {
        const told: Record<string, number> = {};
        for (const [why, at] of Object.entries(t.told ?? {})) if (typeof at === "number") told[why] = at;
        const num = (v: unknown) => typeof v === "number" ? v : undefined;
        this.tracks.set(name, { parkedSince: num(t.parkedSince), blockedSince: num(t.blockedSince), workWoken: num(t.workWoken), failures: num(t.failures) ?? 0, told });
      }
      this.saved = JSON.stringify(Object.fromEntries(this.tracks));
    } catch { /* no file, or not ours: every session starts being looked at in the first round */ }
  }

  private save(): void {
    if (!this.file) return;
    const out: Record<string, Track> = {};
    for (const [name, t] of this.tracks) out[name] = { parkedSince: t.parkedSince, blockedSince: t.blockedSince, workWoken: t.workWoken, failures: t.failures, told: t.told };
    const text = JSON.stringify(out);
    if (text === this.saved) return;
    const temporary = this.file + ".tmp";
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ at: new Date(this.now()).toISOString(), sessions: out }) + "\n");
      renameSync(temporary, this.file);
      this.saved = text;
    } catch (error) { console.error("sessions watch marks not written", error); }
  }

  private track(name: string): Track {
    let t = this.tracks.get(name);
    if (!t) this.tracks.set(name, t = { failures: 0, told: {} });
    return t;
  }

  /** One round: read the sessions, then look at each watched one in turn. A round that finds the previous one still running does nothing. */
  async round(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now(), s = this.store.snapshot(), r = this.store.derived.rules(s, now);
      let rows: SessionRow[];
      try { rows = (await this.claude.sessions()).filter(row => row.kind === "background"); }
      catch (error) { console.error("sessions watch: claude agents unreadable", error); return; }
      const list = watched(s, r);
      for (const w of list) {
        try { await this.look(w, { s, r, rows, now }); }
        catch (error) { console.error(`sessions watch: ${w.name}`, error); }
      }
      const names = new Set(list.map(w => w.name));
      for (const name of [...this.tracks.keys()]) if (!names.has(name)) this.tracks.delete(name);
      this.save();
    } finally { this.running = false; }
  }

  private async look(w: Watched, c: Context): Promise<void> {
    const { s, r, now } = c, t = this.track(w.name);
    // The stuck reports that hold this round; those told before and not in it are over.
    const holds = new Set<StuckWhy>();
    // Wakes that kept failing are told until the session runs again.
    if (t.failures >= WAKE_FAILURES) holds.add("no-resume");
    const report = (why: StuckWhy, text: string): void => {
      holds.add(why);
      if (t.told[why] !== undefined) return;
      t.told[why] = now;
      if (w.role === "pm") { this.wake.tell(`PM ${STUCK_WHY[why]}`, text); return; }
      const item = w.items[0]!;
      this.wake.push("stuck", { session: w.name, item, project: r.projectOf(item), title: s.items[item]!.title, why, text });
    };
    try {
      const named = c.rows.filter(row => row.name === w.name);
      // A copy is for a person to sort out (the original and the copy carry one name): the session is not touched until it runs again.
      if (t.told.copy !== undefined && !(named.length === 1 && phaseOf(named[0]!) === "busy")) { holds.add("copy"); return; }
      if (named.length === 0) {
        // No row: the PM may be a session of another kind; for an engineer or a reviewer the board holds a record no session answers to.
        if (w.role === "pm") return;
        t.parkedSince ??= now;
        if (now - t.parkedSince >= WORK_AFTER_MS) report("missing", "条目还有没结束的派活记录，但 claude 列不出这个会话");
        return;
      }
      if (named.length > 1) { report("duplicate", `${named.length} 个会话叫这个名字：${named.map(row => row.id).join("、")}`); return; }
      const row = named[0]!, phase = phaseOf(row);
      switch (phase) {
        case "busy": {
          t.parkedSince = undefined; t.blockedSince = undefined; t.failures = 0;
          const mail = this.mail(w);
          // A push waits for a tool result, and a session that ended its turn on a command makes none: when it waits too long it is told.
          if (mail && w.role !== "pm" && now - mail.oldest >= UNREAD_AFTER_MS) report("unread", `${mail.count} 条推送 ${minutes(now - mail.oldest)} 分钟没读到，会话一直在忙`);
          return;
        }
        case "unknown": t.parkedSince = undefined; t.blockedSince = undefined; return;
        case "blocked": {
          t.parkedSince = undefined; t.blockedSince ??= now;
          const mail = this.mail(w);
          // A new push may be what unblocks it: wake it as any parked session.
          if (mail && now - t.blockedSince >= QUIET_MS && await this.wakeWith(w, row, c, t, report, this.mailPrompt(mail), mail)) return;
          if (now - t.blockedSince < BLOCKED_AFTER_MS) return;
          // Blocked on a card or another item is a rest, not a stop. A reviewer matters while a review is waiting for it.
          if (w.role === "engineer" && w.items.every(item => r.statusOf(item) === "blocked")) return;
          if (w.role === "reviewer" && !w.items.some(item => reviewRequested(s.items[item]) !== undefined)) return;
          report("blocked", `被拦住 ${minutes(now - t.blockedSince)} 分钟：${await this.claude.needs(row) ?? row.waitingFor ?? "会话没写它要什么"}`);
          return;
        }
        case "gone":
        case "idle": {
          t.blockedSince = undefined;
          t.parkedSince ??= now;
          if (now - t.parkedSince < QUIET_MS) return;
          const mail = this.mail(w);
          if (mail) { await this.wakeWith(w, row, c, t, report, this.mailPrompt(mail), mail); return; }
          if (w.role === "engineer") await this.engineer(w, row, c, t, report);
          else if (w.role === "reviewer") this.reviewer(w, c, t, report);
          return;
        }
        default: { const never: never = phase; throw new Error(`no case for ${String(never)}`); }
      }
    } finally {
      for (const why of Object.keys(t.told)) if (!holds.has(why as StuckWhy)) delete t.told[why];
    }
  }

  /** The pushes owed to the session, as a wake carries them. */
  private mail(w: Watched): Mail | undefined { return w.role === "pm" ? this.wake.pmMail() : this.wake.mail(w.name); }

  private mailPrompt(mail: Mail): string {
    return `【看板叫醒】你停着，看板有推送没送到。看板工具在续上后几秒内可能还连不上，失败就隔几秒再试，别因此停下。\n${mail.text}\n处理后接着做条目的下一步；没有要做的就结束这一轮，下次有推送还会叫醒你。`;
  }

  /** An engineer parked with nothing owed: when its items have work and wait on nothing, wake it once and, if it parks again as long
   * without saying what it waits on, tell the PM. */
  private async engineer(w: Watched, row: SessionRow, c: Context, t: Track, report: Report): Promise<void> {
    const { s, r, now } = c;
    const item = w.items.find(i => hasWorkLeft(r, i) && !awaitsElsewhere(s, r, i));
    if (item === undefined) { t.workWoken = undefined; return; }
    if (now - t.parkedSince! < WORK_AFTER_MS) return;
    if (t.workWoken === undefined) {
      const prompt = `【看板叫醒】你停着，条目 ${item} 还有活，计划里没写你在等什么。接着做；在等人或等别的东西，就在计划行写 waits 或开阻塞卡，不要在会话里提问。看板工具在续上后几秒内可能还连不上，失败就隔几秒再试。`;
      if (await this.wakeWith(w, row, c, t, report, prompt)) t.workWoken = now;
    } else report("stopped", `叫醒过一次，之后又停了 ${minutes(now - t.parkedSince!)} 分钟；条目 ${item} 还有活，计划没写在等什么`);
  }

  /** A reviewer parked with nothing owed while its review is in progress and the engineer is parked too: nobody has a push on the way. */
  private reviewer(w: Watched, c: Context, t: Track, report: Report): void {
    const { s, now } = c;
    const item = w.items.find(i => reviewRequested(s.items[i]) !== undefined);
    if (item === undefined) return;
    const engineer = holderOf(s, item);
    // The engineer was looked at earlier in this round (engineers come first), so its mark is this round's.
    const since = engineer === undefined ? undefined : this.tracks.get(engineer)?.parkedSince;
    if (engineer === undefined || since === undefined) return;
    const together = Math.max(t.parkedSince!, since);
    if (now - together >= CHAIN_AFTER_MS) report("chain", `审查行进行中，审查代理和工程师 ${engineer} 都停了 ${minutes(now - together)} 分钟，没有推送在路上`);
  }

  /**
   * Wake a parked session: read it again, stop its process if it has one, continue it with `prompt`, and check that what claude
   * started is the same session. The pushes in `mail` count as delivered only when that holds. A session that moved since the
   * round read it is left for the next round; a copy is stopped and told, and the session is not woken again until it is looked at
   * by a person; failures are counted, and the PM told at WAKE_FAILURES.
   */
  private async wakeWith(w: Watched, row: SessionRow, c: Context, t: Track, report: Report, prompt: string, mail?: Mail): Promise<boolean> {
    if (t.failures >= WAKE_FAILURES && t.lastTry !== undefined && c.now - t.lastTry < RETRY_AFTER_MS) return false;
    const fresh = (await this.claude.sessions()).filter(x => x.kind === "background" && x.name === w.name);
    const current = fresh[0];
    if (fresh.length !== 1 || current!.sessionId !== row.sessionId) return false;
    const phase = phaseOf(current!);
    if (phase === "busy" || phase === "unknown") { t.parkedSince = undefined; return false; }
    t.lastTry = c.now;
    try {
      if (current!.pid !== undefined) await this.claude.stop(current!);
      const started = await this.claude.resume(current!, prompt);
      if (started === undefined) throw new Error("claude lists no session for what it started");
      if (started.sessionId !== row.sessionId) {
        // The conversation was copied, not continued: the copy must not run beside the original, which is stopped now.
        await this.claude.stop(started).catch(error => console.error(`sessions watch: stopping the copy ${started.id}`, error));
        report("copy", `叫醒 ${w.name} 起出了副本 ${started.id}（${started.sessionId}），已停掉副本；原会话已停，看板不再叫它`);
        return false;
      }
    } catch (error) {
      t.failures += 1;
      console.error(`sessions watch: waking ${w.name} failed (${t.failures})`, error);
      if (t.failures >= WAKE_FAILURES) report("no-resume", `叫了 ${t.failures} 次没叫醒：${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      return false;
    }
    t.failures = 0; t.parkedSince = undefined;
    if (mail) { if (w.role === "pm") this.wake.receipt(mail.upto); else this.wake.deliver(w.name, mail.upto); }
    console.info(`sessions watch: woke ${w.name}${mail ? ` with ${mail.count} push(es)` : " for the work left"}`);
    return true;
  }
}

type Report = (why: StuckWhy, text: string) => void;
/** What one round reads once: the board, the sessions and the time. */
interface Context { s: Snapshot; r: Rules; rows: SessionRow[]; now: number }
