// The machinery of the n-key lane (docs/design.md, section 11, The n-key lane): a window of the real page in jsdom (test/dom/page.ts)
// that presses n on a board of the live board's weight and says what the press cost, with no browser and none of the server's work
// in the time.
//
// - A tape records what the real server answers to the page's reads on a first walk, and every later window is answered from it, so
//   the busy time of a press is the page's own: the server runs in this process, and its work would fall into whichever window is
//   being timed.
// - A window's press is counted (draws, rebuilds of the board's rules, counts of the filters, markup written, elements made) and
//   timed (the seconds the event loop was busy from the key until the page was quiet).
// - Pages that are compared press in turn, in a rotating order, so landing k of every page is one pair.
// - A virtual clock stands in for the page's timers longer than a frame and for the answers a test holds back, so a baseline that
//   arrives 300 ms late is 300 ms of the clock's time and no real waiting.

import { performance as perf } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleScript, DomPage, pageHtml, pageScript } from "../dom/page.ts";
import type { Clock, PageOptions } from "../dom/page.ts";
import { stampPage } from "../../src/page-version.ts";
import type { Item } from "../../src/model.ts";
import { prng } from "../e2e/board-gen.ts";
import { ROOT } from "../e2e/board-server.ts";
import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import { rewrite } from "../e2e/seed.ts";
import type { Revert } from "../e2e/variant.ts";
import { compare, judge, twinIsSound } from "./stats.ts";
import type { Interval, Verdict } from "./stats.ts";

type Fetcher = NonNullable<PageOptions["fetch"]>;
type Loose = Record<string, any>;

/** Closes the windows of one phase together, so that no more than the phase's own are alive at once. */
export class Scope implements Hooks {
  private fns: Array<() => unknown> = [];
  after(fn: () => unknown) { this.fns.push(fn); }
  async close() { for (const fn of this.fns.splice(0).reverse()) await fn(); }
}

/** Time a test moves: `advance` runs the timers due by then in order. The page's timers and the held answers are on it. */
export class VirtualClock implements Clock {
  now = 0;
  private next = 2_000_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): number { const id = this.next++; this.timers.set(id, { at: this.now + ms, fn }); return id; }
  clearTimeout(id: number) { this.timers.delete(id); }
  /** Resolves `ms` of the clock's time from now. */
  sleep(ms: number): Promise<void> { return new Promise(resolve => this.setTimeout(resolve, ms)); }
  /** When the earliest timer is due. */
  due(): number | undefined { let at: number | undefined; for (const t of this.timers.values()) if (at === undefined || t.at < at) at = t.at; return at; }
  advance(to: number) {
    for (;;) {
      let first: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= to && (!first || entry[1].at < first[1].at)) first = entry;
      if (!first) break;
      this.timers.delete(first[0]); this.now = Math.max(this.now, first[1].at); first[1].fn();
    }
    this.now = Math.max(this.now, to);
  }
}

// ---- the tape ----

interface Recorded { status: number; headers: Array<[string, string]>; body: Uint8Array }
/** The server's answers to the page's reads, kept from a first walk and given to every later window. */
export class Tape {
  private answers = new Map<string, Recorded>();
  get size() { return this.answers.size; }
  /** The bytes of the answer kept for a read, or undefined. */
  sizeOf(path: string): number | undefined { return this.answers.get("GET " + path)?.body.length; }
  get bytes() { let n = 0; for (const a of this.answers.values()) n += a.body.length; return n; }
  /** Answers by the real server and keeps each answer; the first answer to a request is the one kept. */
  recorder(): Fetcher {
    return async (url, init) => {
      const response = await fetch(url, init);
      if ((init?.method ?? "GET") === "GET" && response.ok) {
        const key = "GET " + url.pathname + url.search;
        if (!this.answers.has(key)) this.answers.set(key, { status: response.status, headers: [...response.headers.entries()], body: new Uint8Array(await response.clone().arrayBuffer()) });
      }
      return response;
    };
  }
  /** Answers a read from the tape; one it has no answer for (and every write) goes to the real server, whose work then falls into the
   * time, so `misses` says how many reads had none. `wait` may hold an answer back: a promise the window waits for first. */
  player(wait?: (url: URL) => Promise<void> | undefined): { fetch: Fetcher; misses: () => number } {
    let misses = 0;
    return {
      misses: () => misses,
      fetch: async (url, init, page) => {
        const hit = (init?.method ?? "GET") === "GET" ? this.answers.get("GET " + url.pathname + url.search) : undefined;
        if (!hit) { if ((init?.method ?? "GET") === "GET") misses++; return fetch(url, init); }
        const held = wait?.(url);
        if (held) await page.hold(held);
        return new Response(hit.body.slice(), { status: hit.status, headers: hit.headers });
      },
    };
  }
}

// ---- change events as the server's stream carries them ----

/** A reader of the real server's event stream, the only one connected: the data of each `change` event, in order. */
class EventTap {
  private controller = new AbortController();
  private queue: string[] = [];
  private waiting: Array<(data: string) => void> = [];
  readonly ready: Promise<void>;
  constructor(url: string) {
    this.ready = (async () => {
      const response = await fetch(url + "/api/events", { signal: this.controller.signal, headers: { Accept: "text/event-stream" } });
      const reader = (response.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
      const decoder = new TextDecoder(); let buffer = "";
      const first = await reader.next();
      buffer += decoder.decode(first.value, { stream: true });
      void (async () => {
        try {
          for (;;) {
            for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
              const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
              let kind = "message", data = "";
              for (const line of block.split("\n")) { if (line.startsWith("event:")) kind = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
              if (kind === "change") { const waiter = this.waiting.shift(); if (waiter) waiter(data); else this.queue.push(data); }
            }
            const chunk = await reader.next();
            if (chunk.done) return;
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        } catch { /* closed */ }
      })();
    })();
  }
  next(): Promise<string> { const data = this.queue.shift(); return data !== undefined ? Promise.resolve(data) : new Promise(resolve => this.waiting.push(resolve)); }
  close() { this.controller.abort(); }
}

/** `count` change events from real writes to the board, as sessions make them (a log entry on an open item), each the data of the
 * server's own `change` event, in order and each against the commit before it. Made after the tape was recorded: the windows start
 * from the board the tape holds and apply the events one after another. */
export async function writeEvents(board: BoardServer, count: number): Promise<string[]> {
  const tap = new EventTap(board.url);
  try {
    await tap.ready;
    const rnd = prng(777), items = board.store.snapshot().items;
    const ids = Object.keys(items).filter(id => !items[id]!.record);
    const events: string[] = [];
    for (let k = 0; k < count; k++) {
      const id = rnd.pick(ids), group = board.store.snapshot().items[id]!.group, at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      await rewrite<Item>(board.store, "item", id, doc => ({ ...doc, log: [...doc.log, { at, by: group, text: "持续写入。" }], updated: at }), group);
      events.push(await tap.next());
    }
    return events;
  } finally { tap.close(); }
}

// ---- a window the key is pressed in ----

/** What the page marked during one press, and what it wrote. */
export interface Counted {
  /** Draws (`board:render`), builds of the board's rules, of those from scratch the reasons, counts of the filters, baselines asked for. */
  draws: number; rules: number; full: string[]; filters: number; baselines: number;
  /** The scopes of the draws, in order. */
  scopes: string[];
  /** Characters assigned to `innerHTML` and elements made by `createElement`. */
  innerHtml: number; created: number;
}
const noCounts = (): Counted => ({ draws: 0, rules: 0, full: [], filters: 0, baselines: 0, scopes: [], innerHtml: 0, created: 0 });
/** One press that moved to another item; `press` is the number of the press (from 0) in its window. */
export interface Landing extends Counted { item: string; busy: number; press: number }

/** How far the clock is moved on while a press settles: the late answers and waits of a landing are within it. */
const HORIZON_MS = 1000;

export interface OpenHow {
  label: string;
  fetch: Fetcher;
  /** The reads the tape had no answer for, when the window is answered from one. */
  misses?: () => number;
  /** The page of another commit, or the current page with fixes reversed. */
  page?: { script: string; html: string };
  reverts?: Revert[];
  stream?: "server" | "manual";
  clock?: VirtualClock;
}

export class Press {
  readonly label: string;
  readonly page: DomPage;
  private counts: Counted;
  private clock: VirtualClock | undefined;
  private missed: () => number;
  /** Presses made, so a test can give each press its own change event. */
  presses = 0;
  private constructor(label: string, page: DomPage, counts: { current: Counted }, clock: VirtualClock | undefined, missed: () => number) {
    this.label = label; this.page = page; this.clock = clock; this.missed = missed;
    this.counts = counts.current;
  }

  /** Opens the page on `board` and waits until it has drawn. */
  static async open(scope: Hooks, board: BoardServer, how: OpenHow): Promise<Press> {
    const counted = { current: noCounts() };
    const options: PageOptions = {
      fetch: how.fetch,
      stream: how.stream ?? "manual",
      onMark: (name, detail) => {
        const c = counted.current;
        if (name === "board:render") { c.draws++; c.scopes.push(String(detail)); }
        else if (name === "board:rules") c.rules++;
        else if (name === "board:rules-full") c.full.push(String(detail));
        else if (name === "board:filter-counts") c.filters++;
        else if (name === "board:baseline") c.baselines++;
      },
      // The cost of what the page writes: markup assigned to innerHTML, elements made.
      setup: page => {
        const win = page.win as Loose, proto = win.Element.prototype, inner = Object.getOwnPropertyDescriptor(proto, "innerHTML")!;
        Object.defineProperty(proto, "innerHTML", { ...inner, set(this: unknown, v: unknown) { counted.current.innerHtml += String(v).length; inner.set!.call(this, v); } });
        const make = win.document.createElement.bind(win.document);
        win.document.createElement = (...args: unknown[]) => { counted.current.created++; return make(...args); };
        // The page redoes its rules when a minute passes, which would fall into whichever press it meets: the minute tick is held still.
        const every = win.setInterval.bind(win);
        win.setInterval = (fn: unknown, delay: number, ...rest: unknown[]) => delay >= 30_000 ? 0 : every(fn, delay, ...rest);
      },
      ...(how.page ? { page: how.page } : { reverts: how.reverts ?? [] }),
      ...(how.clock ? { clock: how.clock } : {}),
    };
    const page = await DomPage.open(scope, board, options);
    page.blur();
    counted.current = noCounts();
    return new Press(how.label, page, counted, how.clock, how.misses ?? (() => 0));
  }

  get misses() { return this.missed(); }
  selected() { return this.page.selected(); }
  close() { this.page.close(); }

  /** Waits until the page is quiet; with a clock, moves it on to each timer and answer that is due soon, until none is. */
  private async quiet() {
    await this.page.settle();
    const clock = this.clock;
    if (!clock) return;
    for (let k = 0; k < 400; k++) {
      const due = clock.due();
      if (due === undefined || due - clock.now > HORIZON_MS) return;
      clock.advance(due);
      await this.page.settle();
    }
    throw new Error("the page kept scheduling timers within a second of the clock's time and never went quiet");
  }

  /** One press of n, with the change event of a session's write delivered right after the key when given: the seconds the event loop was
   * busy until the page was quiet, the item shown afterwards, and what the page marked and wrote. */
  async press(event?: string): Promise<{ busy: number; item: string | null; counted: Counted }> {
    this.presses++;
    const live = this.counts;
    Object.assign(live, noCounts());
    const before = perf.eventLoopUtilization();
    this.page.key("n");
    if (event !== undefined) this.page.deliver("change", event);
    await this.quiet();
    const busy = perf.eventLoopUtilization(before).active;
    return { busy, item: this.selected(), counted: { ...live, full: [...live.full], scopes: [...live.scopes] } };
  }
}

/** Presses n in `win` until it has landed on `wanted` other items (a press inside the item shown does not count). `events` gives press
 * k its change event, when it has one. `progress` says how many have landed, for a test that sets the time of answers per landing, and may end the walk
 * early with `done`. */
export async function landings(win: Press, wanted: number, events?: readonly (string | undefined)[], progress?: { landed: number; done?: () => boolean }): Promise<Landing[]> {
  const out: Landing[] = [];
  for (let presses = 0; out.length < wanted && !progress?.done?.() && presses < 8 * wanted; presses++) {
    if (events && win.presses >= events.length) throw new Error(`the walk made ${win.presses} presses and there are only ${events.length} change events for them`);
    const was = win.selected(), r = await win.press(events?.[win.presses]);
    if (r.item !== null && r.item !== was) out.push({ item: r.item, busy: r.busy, press: win.presses - 1, ...r.counted });
    if (progress) progress.landed = out.length;
  }
  return out;
}

/** Presses n in each window in turn, the order rotating press by press, until every window has landed `wanted` other items on the same
 * presses; landing k of every window is then a pair. Windows walk the same list, so they land together. */
export async function pairedLandings(wins: readonly Press[], wanted: number, events?: readonly (string | undefined)[]): Promise<Record<string, Landing[]>> {
  const out: Record<string, Landing[]> = Object.fromEntries(wins.map(w => [w.label, []]));
  const was: Record<string, string | null> = Object.fromEntries(wins.map(w => [w.label, w.selected()]));
  for (let presses = 0; out[wins[0]!.label]!.length < wanted && presses < 8 * wanted; presses++) {
    if (events && wins[0]!.presses >= events.length) throw new Error(`the walk made ${wins[0]!.presses} presses and there are only ${events.length} change events for them`);
    const rot = presses % wins.length, order = [...wins.slice(rot), ...wins.slice(0, rot)];
    const got: Array<[string, Landing | null]> = [];
    for (const win of order) {
      const r = await win.press(events?.[win.presses]);
      got.push([win.label, r.item !== null && r.item !== was[win.label] ? { item: r.item, busy: r.busy, press: win.presses - 1, ...r.counted } : null]);
      was[win.label] = r.item;
    }
    // A pair counts only if every window moved to another item.
    if (got.every(([, l]) => l)) for (const [label, l] of got) out[label]!.push(l!);
  }
  return out;
}

// ---- the pages that are compared ----

/** The page as one commit had it, built from that commit's `web/` and `src/` in a temporary directory; undefined when the commit is not
 * in this checkout. */
export async function pageAt(ref: string): Promise<{ script: string; html: string } | undefined> {
  let tar: Buffer;
  try { tar = execFileSync("git", ["archive", "--format=tar", ref, "web", "src"], { cwd: ROOT, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }); } catch { return undefined; }
  const dir = await mkdtemp(join(tmpdir(), "wf-board-base-"));
  try {
    execFileSync("tar", ["-x", "-C", dir], { input: tar });
    const html = stampPage(await readFile(join(dir, "web/index.html"), "utf8"), undefined);
    return { script: await bundleScript(await readFile(join(dir, "web/app.ts"), "utf8"), join(dir, "web")), html };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
/** The current page. */
export async function currentPage(): Promise<{ script: string; html: string }> { return { script: await pageScript(), html: await pageHtml() }; }
/** Whether two pages are the same code and markup (the comment lines esbuild writes name files and differ with where they were built). */
export function samePage(a: { script: string; html: string }, b: { script: string; html: string }): boolean {
  const code = (text: string) => text.split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
  return a.html === b.html && code(a.script) === code(b.script);
}

// ---- the time layer ----

/** Pairs measured per round, the pairs thrown away at the start of a round while the page warms up, and the rounds at most. */
export const PAIRS = 30, WARMUP = 2, ROUNDS = 3;

/** `versus`: the window this one is judged against, `base` unless given (a page made slower on purpose is judged against the page it was made from). */
export interface PhaseWindow { label: string; open: (scope: Hooks) => Promise<Press>; versus?: string }
export interface PhaseResult {
  /** The landings of the first round, all windows, for the counts. */
  first: Record<string, Landing[]>;
  /** Busy times of the measured pairs of all rounds, per window. */
  busy: Record<string, number[]>;
  rounds: number;
  /** Per window other than `base`: its ratio to the window it is judged against (`base` unless it says otherwise) over the pairs; `twin` is the noise of this run. */
  ratios: Record<string, Interval>;
  /** The window each ratio is against. */
  versus: Record<string, string>;
  /** `sound`: the twin's interval holds 1 within `floor`; per window other than base and twin the verdict. */
  sound: boolean;
  verdicts: Record<string, Verdict>;
  misses: Record<string, number>;
}

/** Presses the windows in turn over `PAIRS` landings plus the warm-up, in fresh windows each round, until the twin's interval shows this
 * run's noise within `floor` or `ROUNDS` rounds were made. A round replays the same landings from the same tape; the windows of a round
 * are closed before the next opens. Windows: `base` first, `twin` its twin, then the pages that are judged against base. */
export async function timePhase(windows: readonly PhaseWindow[], floor: number, events?: readonly (string | undefined)[]): Promise<PhaseResult> {
  const busy: Record<string, number[]> = Object.fromEntries(windows.map(w => [w.label, []]));
  const misses: Record<string, number> = Object.fromEntries(windows.map(w => [w.label, 0]));
  let first: Record<string, Landing[]> | undefined, rounds = 0, ratios: Record<string, Interval> = {}, sound = false;
  while (rounds < ROUNDS && !sound) {
    rounds++;
    const scope = new Scope();
    try {
      const open: Press[] = [];
      for (const w of windows) open.push(await w.open(scope));
      const lands = await pairedLandings(open, WARMUP + PAIRS, events);
      first ??= lands;
      for (const w of open) { misses[w.label]! += w.misses; busy[w.label]!.push(...lands[w.label]!.slice(WARMUP).map(l => l.busy)); }
    } finally { await scope.close(); }
    ratios = Object.fromEntries(windows.slice(1).map(w => [w.label, compare(busy[w.label]!, busy[w.versus ?? windows[0]!.label]!)]));
    sound = twinIsSound(ratios.twin!, floor);
  }
  const verdicts = Object.fromEntries(windows.slice(2).map(w => [w.label, judge(ratios.twin!, ratios[w.label]!, floor)]));
  const versus = Object.fromEntries(windows.slice(1).map(w => [w.label, w.versus ?? windows[0]!.label]));
  return { first: first!, busy, rounds, ratios, versus, sound, verdicts, misses };
}
