import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Wake } from "./wake.ts";

/** How long a session holding an item may give no sign before the board asks it. */
export const ASK_AFTER_MS = 30 * 60_000;

/** What the board knows of one session between signs: when the silence began, and how far it has gone. */
interface Silence {
  /** The last sign of life, or the first moment the board saw the session holding an item in progress, whichever is later; after a
   * restart, moved on by the time the board was stopped. */
  since: number;
  /** When the session was asked; set once per silence. */
  asked?: number;
}

export interface LivenessOptions {
  wake: Wake;
  now?: () => number;
  /** Where the silences are kept, so a restart neither loses the time already silent nor repeats a push; without it they live in memory only. */
  file?: string;
  askMs?: number;
}

/**
 * Whether the sessions holding items in progress are still there (docs/design.md, The wake streams, Liveness). A session gives a sign of
 * life by calling any tool as itself (`see`, from the tool wrapper in src/mcp.ts) or by its wait script sending an alive frame
 * on the session's stream (`see`, from src/http.ts); a connection alone is none, since a script outlives a stopped session.
 * After ASK_AFTER_MS without a sign the board puts an ask in the session's own stream and goes no further: whether a session
 * that does not answer is stopped is for the architect's patrol to find in the whole view. A sign at any time ends the silence,
 * and the next one starts over, so one silence is asked once.
 */
export class Liveness {
  private readonly wake: Wake;
  private readonly now: () => number;
  private readonly file?: string;
  private readonly askMs: number;
  private readonly silences = new Map<string, Silence>();

  constructor(options: LivenessOptions) {
    this.wake = options.wake;
    this.now = options.now ?? Date.now;
    this.file = options.file;
    this.askMs = options.askMs ?? ASK_AFTER_MS;
    this.load(this.now());
  }

  /** Read the silences of the last run. The time the board was stopped since its last round is not the sessions' silence: it is
   * added to every time a silence is counted from, so a session silent for 20 minutes before a restart is silent for 20 after it. */
  private load(started: number): void {
    if (!this.file) return;
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8")) as { at?: unknown; silences?: Record<string, { since?: unknown; asked?: unknown }> };
      const stopped = typeof doc.at === "number" ? Math.max(0, started - doc.at) : 0;
      for (const [name, mark] of Object.entries(doc.silences ?? {})) {
        if (typeof mark.since !== "number") continue;
        const silence: Silence = { since: mark.since + stopped };
        if (typeof mark.asked === "number") silence.asked = mark.asked + stopped;
        this.silences.set(name, silence);
      }
    } catch { /* no file, or not ours: every silence starts at the first round that sees the session */ }
  }

  /** The session gave a sign of life now. */
  see(name: string): void {
    const before = this.silences.get(name);
    this.silences.set(name, { since: this.now() });
    if (before?.asked !== undefined) this.save();
  }

  /**
   * One round, from the server's minute timer. `holding` maps each session holding an item to the items it holds (the one
   * reading of that is `holders` in src/dispatch.ts); `about` gives the project and title a push names an item by. Sessions that
   * hold nothing are forgotten.
   */
  check(holding: ReadonlyMap<string, readonly string[]>, about: (item: string) => { project: string; title: string }): void {
    const now = this.now();
    for (const [name, items] of holding) {
      let silence = this.silences.get(name);
      if (!silence) this.silences.set(name, silence = { since: now });
      if (silence.asked !== undefined || now - silence.since < this.askMs) continue;
      const item = items[0]!;
      silence.asked = now;
      this.wake.push("ask-alive", { item, ...about(item), since: new Date(silence.since).toISOString() });
    }
    for (const name of this.silences.keys()) if (!holding.has(name)) this.silences.delete(name);
    this.save();
  }

  /** Write the silences with the time of this round, which tells the next start how long the board was stopped. A round writes
   * once; a sign writes at once only when it ends an ask, so a restart cannot bring that back. */
  private save(): void {
    if (!this.file) return;
    const temporary = this.file + ".tmp";
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ at: this.now(), silences: Object.fromEntries(this.silences) }) + "\n");
      renameSync(temporary, this.file);
    } catch (error) { console.error("liveness silences not written", error); }
  }
}
