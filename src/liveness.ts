import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Wake } from "./wake.ts";

/** How long a session holding an item may give no sign before the board asks it, and how long after the ask before the PM is told. */
export const ASK_AFTER_MS = 30 * 60_000;
export const TELL_AFTER_MS = 30 * 60_000;

/** What the board knows of one session between signs: when the silence began, and how far it has gone. */
interface Silence {
  /** The last sign of life, or the moment the board first saw the session holding an item, or the board's start. */
  since: number;
  /** When the session was asked; set once per silence. */
  asked?: number;
  /** When the PM was told; set once per silence. */
  told?: number;
}

export interface LivenessOptions {
  wake: Wake;
  now?: () => number;
  /** Where the asked and told marks are kept, so a restart neither forgets nor repeats a push; without it they live in memory only. */
  file?: string;
  askMs?: number;
  tellMs?: number;
}

/**
 * Whether the sessions holding items are still there (docs/design.md, The wake streams, Liveness). A session gives a sign of
 * life by calling any tool as itself (`see`, from the tool wrapper) or by having its wait script connected (`check` asks
 * the server which sessions are). After ASK_AFTER_MS without one the board puts an ask in the session's own stream; after
 * TELL_AFTER_MS more it pushes "no answer" to the PM. A sign at any time ends the silence, and the next one starts over, so
 * one silence is told once.
 */
export class Liveness {
  private readonly wake: Wake;
  private readonly now: () => number;
  private readonly file?: string;
  private readonly askMs: number;
  private readonly tellMs: number;
  private readonly silences = new Map<string, Silence>();

  constructor(options: LivenessOptions) {
    this.wake = options.wake;
    this.now = options.now ?? Date.now;
    this.file = options.file;
    this.askMs = options.askMs ?? ASK_AFTER_MS;
    this.tellMs = options.tellMs ?? TELL_AFTER_MS;
    this.load(this.now());
  }

  /** Read the marks of the last run. Their silences start anew at `started`: the board was not there to hear a sign while it
   * was down, so a session asked before the restart gets its whole time to answer after it. A told session stays told until a sign. */
  private load(started: number): void {
    if (!this.file) return;
    try {
      const marks = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, { asked?: unknown; told?: unknown }>;
      for (const [name, mark] of Object.entries(marks)) {
        const silence: Silence = { since: started };
        if (typeof mark.asked === "number") silence.asked = Math.max(mark.asked, started);
        if (typeof mark.told === "number") silence.told = mark.told;
        if (silence.asked !== undefined || silence.told !== undefined) this.silences.set(name, silence);
      }
    } catch { /* no file, or not ours: every silence starts at the board's start */ }
  }

  /** The session gave a sign of life now. */
  see(name: string): void {
    const before = this.silences.get(name);
    this.silences.set(name, { since: this.now() });
    if (before?.asked !== undefined || before?.told !== undefined) this.save();
  }

  /**
   * One round, from the server's minute timer. `holding` maps each session holding an item to the items it holds (the one
   * reading of that is `holders` in src/dispatch.ts); `connected` says whether a session's wait script is connected now, which
   * counts as a sign; `about` gives the project and title a push names an item by. Sessions that hold nothing are forgotten.
   */
  check(holding: ReadonlyMap<string, readonly string[]>, connected: (name: string) => boolean, about: (item: string) => { project: string; title: string }): void {
    const now = this.now();
    for (const [name, items] of holding) {
      if (connected(name)) { this.see(name); continue; }
      let silence = this.silences.get(name);
      if (!silence) this.silences.set(name, silence = { since: now });
      if (silence.told !== undefined) continue;
      const item = items[0]!, last = new Date(silence.since).toISOString();
      if (silence.asked === undefined) {
        if (now - silence.since < this.askMs) continue;
        silence.asked = now;
        this.save();
        this.wake.push("ask-alive", { item, ...about(item), since: last });
      } else if (now - silence.asked >= this.tellMs) {
        silence.told = now;
        this.save();
        this.wake.push("no-answer", { session: name, item, ...about(item), since: last });
      }
    }
    let dropped = false;
    for (const [name, silence] of this.silences) {
      if (holding.has(name)) continue;
      this.silences.delete(name);
      dropped ||= silence.asked !== undefined || silence.told !== undefined;
    }
    if (dropped) this.save();
  }

  /** Write the marks of the silences that have gone as far as an ask; the others cost nothing to lose. */
  private save(): void {
    if (!this.file) return;
    const marks: Record<string, { asked?: number; told?: number }> = {};
    for (const [name, { asked, told }] of this.silences) if (asked !== undefined || told !== undefined) marks[name] = { ...(asked === undefined ? {} : { asked }), ...(told === undefined ? {} : { told }) };
    const temporary = this.file + ".tmp";
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify(marks) + "\n");
      renameSync(temporary, this.file);
    } catch (error) { console.error("liveness marks not written", error); }
  }
}
