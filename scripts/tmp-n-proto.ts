// TMP-MEASURE (item ci-under-1min-study, never merged): the time layer of the n-press check in Node, with no browser.
// The real page runs in jsdom on a board of the live board's weight (test/e2e/live-board.ts); the page's requests are answered
// from a first walk's recordings, so the server's work is not in the measured time. Several windows (pages) press n in turn,
// in a rotating order, so landing k of every window is one pair; the twin of the base is the control. Prints NPROTO lines.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance as perf } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { startLiveBoard } from "../test/e2e/live-board.ts";
import { ROOT } from "../test/e2e/harness.ts";

const LANDINGS = Number(process.env.NP_LANDINGS ?? 30), WARM = 2;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const out = (kind: string, data: unknown) => console.log("NPROTO " + kind + " " + JSON.stringify(data));
const t00 = perf.now();
const lap = (label: string) => out("lap", { label, s: Number(((perf.now() - t00) / 1000).toFixed(2)) });
const cleanups: Array<() => unknown> = [];
const hooks = { after: (fn: () => unknown) => { cleanups.push(fn); } };
const errors: string[] = [];
process.on("unhandledRejection", e => { errors.push("unhandledRejection " + String(e instanceof Error ? e.stack : e).split("\n").slice(0, 3).join(" | ")); });

const board = await startLiveBoard(hooks);
lap(`live board seeded (${Object.keys(board.store.snapshot().items).length} items)`);
const html = await (await fetch(board.url + "/")).text();

// ---- the page, in text, with optional edits (the regression witnesses of press-n.e2e.ts) ----
const appText = await readFile(join(ROOT, "web/app.ts"), "utf8");
const edit = (text: string, find: string, replace: string) => {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + 1) >= 0) throw new Error("edit no longer matches once: " + find.slice(0, 60));
  return text.slice(0, at) + replace + text.slice(at + find.length);
};
const slow = (ms: number) => (t: string) => edit(t, '    countEvent("board:render", [...scope].join(","));\n', `    countEvent("board:render", [...scope].join(","));\n    for (const began = performance.now(); performance.now() - began < ${ms};) {}\n`);
const filtersEachDraw = (t: string) => edit(t, "  function invalidateView() { memo = {}; }", "  function invalidateView() { memo = {}; dataMemo = {}; }");
const rebuildsRules = (t: string) => edit(edit(t, "    invalidateView(); scope.forEach(s => dirty.add(s));\n    if (renderQueued) return;", "    invalidate(); scope.forEach(s => dirty.add(s));\n    if (renderQueued) return;"), "function renderNow(...scope:string[]) { invalidateView();", "function renderNow(...scope:string[]) { invalidate();");
const drawsThreeTimes = (t: string) => edit(t, "unfolded = openPath(it.id, false);\n      selectItem(it.id, false);", "unfolded = openPath(it.id);\n      selectItem(it.id);");
async function bundle(change?: (t: string) => string): Promise<string> {
  const contents = change ? change(appText) : appText;
  return (await build({ stdin: { contents, resolveDir: join(ROOT, "web"), sourcefile: "app.ts", loader: "ts" }, bundle: true, format: "iife", target: "es2022", write: false, logLevel: "silent" })).outputFiles[0]!.text;
}
const base = await bundle();
lap("page bundled");

// ---- recordings of the server's answers ----
interface Answer { status: number; headers: Array<[string, string]>; body: Uint8Array }
const recorded = new Map<string, Answer>();

// ---- a window ----
interface Counts { render: number; rules: number; filters: number; baseline: number; innerBytes: number; created: number }
const zero = (): Counts => ({ render: 0, rules: 0, filters: 0, baseline: 0, innerBytes: 0, created: 0 });
interface Win { w: any; doc: any; st: { inflight: number; pending: number; draws: number; counts: Counts; misses: number }; selected(): string | null; press(): Promise<{ busy: number; wall: number; counts: Counts; item: string | null }>; close(): void }

async function openWindow(code: string, mode: "record" | "replay"): Promise<Win> {
  const began = perf.now();
  const w: any = new JSDOM(html, { url: board.url + "/", pretendToBeVisual: true, runScripts: "outside-only" }).window;
  const st = { inflight: 0, pending: 0, draws: 0, counts: zero(), misses: 0 };
  const realFetch = globalThis.fetch.bind(globalThis);
  w.fetch = async (input: unknown, init?: RequestInit) => {
    st.inflight++;
    try {
      const url = new URL(String(input), board.url), key = (init?.method ?? "GET") + " " + url.pathname + url.search;
      if (mode === "replay" && (init?.method ?? "GET") === "GET") {
        const hit = recorded.get(key);
        if (hit) { await Promise.resolve(); return new Response(hit.body.slice(), { status: hit.status, headers: hit.headers }); }
        st.misses++;
      }
      const res = await realFetch(url, init);
      if (mode === "record" && (init?.method ?? "GET") === "GET") {
        const body = new Uint8Array(await res.clone().arrayBuffer());
        recorded.set(key, { status: res.status, headers: [...res.headers.entries()], body });
      }
      return res;
    } finally { st.inflight--; }
  };
  // Timers up to half a second are counted, so "quiet" means nothing the page scheduled is left.
  const ids = new Set<unknown>();
  w.setTimeout = (fn: (...a: unknown[]) => unknown, delay = 0, ...rest: unknown[]) => {
    if (delay > 500) return setTimeout(fn, delay, ...rest) as unknown as number;
    st.pending++;
    const id = setTimeout(() => { if (ids.delete(id)) st.pending--; fn(...rest); }, delay); ids.add(id); return id as unknown as number;
  };
  w.clearTimeout = (id: any) => { if (ids.delete(id)) st.pending--; clearTimeout(id); };
  w.requestAnimationFrame = (fn: (now: number) => void) => w.setTimeout(() => fn(perf.now()), 0);
  w.cancelAnimationFrame = (id: number) => w.clearTimeout(id);
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  // The event stream: opens at once and carries no events (nothing writes during the walk).
  w.EventSource = class { onopen?: () => unknown; onerror?: () => unknown; constructor() { setTimeout(() => this.onopen?.(), 0); } addEventListener() {} close() {} };
  try { w.CSS = { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => "\\" + c) }; } catch { /* own */ }
  w.structuredClone = structuredClone;
  w.AbortController = AbortController; w.AbortSignal = AbortSignal;
  for (const proto of [w.Element?.prototype, w.HTMLElement?.prototype]) if (proto) { proto.scrollIntoView ??= function () {}; proto.scrollTo ??= function () {}; proto.scrollBy ??= function () {}; }
  w.scrollTo ??= () => {}; w.scrollBy ??= () => {};
  w.performance.clearMarks ??= () => {};
  const mark0 = w.performance.mark?.bind(w.performance);
  w.performance.mark = (name: string, ...rest: unknown[]) => {
    if (name === "board:render") { st.draws++; st.counts.render++; } else if (name === "board:rules") st.counts.rules++; else if (name === "board:filter-counts") st.counts.filters++; else if (name === "board:baseline") st.counts.baseline++;
    return mark0?.(name, ...rest);
  };
  // Deterministic cost counters: bytes of markup assigned to innerHTML, elements created.
  const inner = Object.getOwnPropertyDescriptor(w.Element.prototype, "innerHTML")!;
  Object.defineProperty(w.Element.prototype, "innerHTML", { ...inner, set(v: unknown) { st.counts.innerBytes += String(v).length; inner.set!.call(this, v); } });
  const ce = w.document.createElement.bind(w.document);
  w.document.createElement = (...a: unknown[]) => { st.counts.created++; return (ce as any)(...a); };
  w.addEventListener("error", (e: any) => { errors.push("window error " + (e.message ?? e)); });
  const doc = w.document;
  try { w.eval(code); } catch (e) { errors.push("page eval: " + String((e as Error).stack).split("\n").slice(0, 4).join(" | ")); }
  for (let k = 0; k < 4000 && !(doc.querySelector("#sendbox:not([hidden])") && doc.querySelector("#areas .item")); k++) await new Promise<void>(r => setTimeout(r, 5));
  const settle = async () => {
    for (let k = 0; k < 400; k++) {
      while (st.inflight > 0 || st.pending > 0) await tick();
      const before = st.draws;
      await tick(); await tick();
      if (st.inflight === 0 && st.pending === 0 && st.draws === before) return;
    }
  };
  await settle();
  (doc.activeElement as any)?.blur?.();
  const selected = () => { const d = doc.querySelector("#item-detail > .item"); return d ? d.id.slice("detail-it-".length) : null; };
  st.counts = zero();
  out("window", { mode, open_s: Number(((perf.now() - began) / 1000).toFixed(2)), rows: doc.querySelectorAll("#areas .item").length, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6), rssMB: Math.round(process.memoryUsage().rss / 1e6) });
  return {
    w, doc, st, selected,
    async press() {
      st.counts = zero();
      const e0 = perf.eventLoopUtilization(), t0 = perf.now();
      doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "n", bubbles: true }));
      await settle();
      const busy = perf.eventLoopUtilization(e0).active, wall = perf.now() - t0;
      return { busy, wall, counts: { ...st.counts }, item: selected() };
    },
    close() { try { w.close(); } catch { /* ignore */ } },
  };
}

// ---- the walk ----
/** Presses n on every window in the rotation of that landing until each has landed `wanted` other items; pairs are by landing. */
interface Landing { item: string; busy: number; wall: number; counts: Counts }
async function walk(wins: Array<{ label: string; win: Win }>, wanted: number): Promise<Record<string, Landing[]>> {
  const lands: Record<string, Landing[]> = Object.fromEntries(wins.map(x => [x.label, []]));
  const was: Record<string, string | null> = Object.fromEntries(wins.map(x => [x.label, x.win.selected()]));
  for (let presses = 0; presses < 8 * wanted; presses++) {
    const rot = presses % wins.length, order = [...wins.slice(rot), ...wins.slice(0, rot)];
    const landed: Array<[string, Landing | null]> = [];
    for (const { label, win } of order) {
      const r = await win.press();
      landed.push([label, r.item !== null && r.item !== was[label] ? { item: r.item, busy: r.busy, wall: r.wall, counts: r.counts } : null]);
      was[label] = r.item;
    }
    // The pair counts only if every window moved to another item (they walk the same list).
    if (landed.every(([, l]) => l)) for (const [label, l] of landed) lands[label]!.push(l!);
    if (lands[wins[0]!.label]!.length >= wanted) break;
  }
  return lands;
}

// ---- statistics ----
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };
const tq = (df: number) => { const z = 1.96; return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df); };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
/** Ratio of `a` to `b` over pairs: geometric mean of per-landing ratios with its 95% t-interval, and the ratio of medians. */
function ratio(a: number[], b: number[]) {
  const lr = a.map((x, k) => Math.log(x / b[k]!)), n = lr.length, m = mean(lr), h = tq(n - 1) * sd(lr) / Math.sqrt(n);
  return { n, geo: Number(Math.exp(m).toFixed(4)), lo: Number(Math.exp(m - h).toFixed(4)), hi: Number(Math.exp(m + h).toFixed(4)), half_pct: Number(((Math.exp(h) - 1) * 100).toFixed(2)), ofMedians: Number((median(a) / median(b)).toFixed(4)) };
}
function report(phase: string, lands: Record<string, Landing[]>, baseLabel: string) {
  const items = Object.fromEntries(Object.entries(lands).map(([k, v]) => [k, v.slice(WARM).map(l => l.item)]));
  const sameWalk = Object.values(items).every(v => v.join() === items[baseLabel]!.join());
  const countsOf = (label: string) => lands[label]!.slice(WARM).map(l => l.counts);
  const sum = (label: string, key: keyof Counts) => countsOf(label).reduce((a, c) => a + c[key], 0);
  const per: Record<string, unknown> = {};
  for (const [label, v] of Object.entries(lands)) {
    const meas = v.slice(WARM);
    per[label] = {
      landings: meas.length, busy_ms_median: Number(median(meas.map(l => l.busy)).toFixed(1)), wall_ms_median: Number(median(meas.map(l => l.wall)).toFixed(1)),
      counts_per_landing_median: Object.fromEntries((Object.keys(zero()) as Array<keyof Counts>).map(k => [k, median(countsOf(label).map(c => c[k]))])),
      counts_totals: { render: sum(label, "render"), rules: sum(label, "rules"), filters: sum(label, "filters"), baseline: sum(label, "baseline") },
    };
  }
  const ratios: Record<string, unknown> = {};
  for (const label of Object.keys(lands)) if (label !== baseLabel) ratios[`${label}/${baseLabel}`] = ratio(lands[label]!.slice(WARM).map(l => l.busy), lands[baseLabel]!.slice(WARM).map(l => l.busy));
  out("phase", { phase, sameWalk, per, ratios_busy: ratios });
  out("busy_series", { phase, series: Object.fromEntries(Object.entries(lands).map(([k, v]) => [k, v.slice(WARM).map(l => Number(l.busy.toFixed(1)))])) });
}

async function runPhase(phase: string, variants: Array<{ label: string; code: string }>) {
  const began = perf.now();
  const wins: Array<{ label: string; win: Win }> = [];
  for (const v of variants) wins.push({ label: v.label, win: await openWindow(v.code, "replay") });
  const opened = perf.now();
  const lands = await walk(wins, LANDINGS + WARM);
  const done = perf.now();
  const misses = wins.map(x => x.win.st.misses);
  out("phase_time", { phase, windows: variants.length, open_s: Number(((opened - began) / 1000).toFixed(1)), walk_s: Number(((done - opened) / 1000).toFixed(1)), replay_misses: misses, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6), rssMB: Math.round(process.memoryUsage().rss / 1e6) });
  report(phase, lands, variants[0]!.label);
  for (const x of wins) x.win.close();
}

// ---- first walk: the real server answers; the recording serves every later window ----
{
  const began = perf.now();
  const rec = await openWindow(base, "record");
  const lands = await walk([{ label: "recorder", win: rec }], LANDINGS + WARM);
  out("recording", { s: Number(((perf.now() - began) / 1000).toFixed(1)), answers: recorded.size, bytes: [...recorded.values()].reduce((a, r) => a + r.body.length, 0), landings: lands.recorder!.length, busy_ms_median_with_server: Number(median(lands.recorder!.map(l => l.busy)).toFixed(1)), draws_per_landing: [...new Set(lands.recorder!.map(l => l.counts.render))] });
  rec.close();
}
lap("recorded");

const phases = (process.env.NP_PHASES ?? "noise,slow,counts").split(",");
if (phases.includes("noise")) await runPhase("noise", [{ label: "base", code: base }, { label: "twin", code: base }, { label: "same", code: base }]);
lap("noise done");
if (phases.includes("slow")) await runPhase("slow", [{ label: "base", code: base }, { label: "twin", code: base }, { label: "slow15", code: await bundle(slow(15)) }, { label: "slow150", code: await bundle(slow(150)) }]);
lap("slow done");
if (phases.includes("counts")) await runPhase("counts", [{ label: "base", code: base }, { label: "filtersEachDraw", code: await bundle(filtersEachDraw) }]);
lap("counts done");
if (phases.includes("witness")) await runPhase("witness", [{ label: "base", code: base }, { label: "rebuildsRules", code: await bundle(rebuildsRules) }, { label: "drawsThreeTimes", code: await bundle(drawsThreeTimes) }, { label: "allThree", code: await bundle(t => drawsThreeTimes(rebuildsRules(filtersEachDraw(t)))) }]);
lap("witness done");
if (errors.length) out("errors", errors.slice(0, 6));
for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* ignore */ } }
process.exit(0);
