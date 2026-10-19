// What one change event costs the owner's open page, on a board of the live board's weight (test/e2e/live-board.ts: about
// 1,600 items, a 15 MB snapshot, 330 unread commits). It serves the board item that cuts the board's CPU per write, whose
// acceptance holds the page's work per change event to 50 ms, and is run by the `bench` workflow (by hand).
//
// The real page runs in jsdom (test/dom/page.ts) in this process. Writes are made through the server's operations as sessions
// make them: `set_tags`, a change the owner reads, so the page asks again for the unread list and for the new stop's baseline,
// and a log entry, which the owner never reads. A first page, connected to the real server, records every answer it is given
// after each write, and the change events are taken off the server's stream. A second page, opened before the writes on the
// board as it was, is then given the same events one at a time and answered from those recordings, so the time measured is
// the page's own and none of the server's. For each event it prints the seconds the event loop was busy from the event until
// the page was quiet (no fetch in flight, no frame or short timer waiting), which bounds the longest task from above.
//
// Usage: node scripts/bench-page.ts [--writes N] [--warmup N] [--profile]
//   --writes is the number of events of each kind measured (default 100); --warmup the events of each kind given first and
//   not measured (default 10); --profile prints where the page's time goes over the set_tags events.
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { DomPage } from "../test/dom/page.ts";
import { startLiveBoard } from "../test/e2e/live-board.ts";
import { rewrite } from "../test/e2e/seed.ts";
import { prng } from "../test/e2e/board-gen.ts";
import { EventTap } from "../test/nkey/press.ts";
import type { Item } from "../src/model.ts";
import { rules } from "../src/rules.ts";
import { profiled } from "./profile-summary.ts";

const { values: args } = parseArgs({ options: {
  writes: { type: "string", default: "100" }, warmup: { type: "string", default: "10" }, profile: { type: "boolean", default: false },
} });
const WRITES = Number(args.writes), WARMUP = Number(args.warmup);

const cleanups: Array<() => unknown> = [];
const hooks = { after: (fn: () => unknown) => { cleanups.push(fn); } };
interface Recorded { status: number; headers: Array<[string, string]>; body: Uint8Array }
const key = (url: URL) => url.pathname + url.search;

try {
  const board = await startLiveBoard(hooks);
  // The page that is measured: opened now, on the board before the writes, with a stream that carries only what is delivered.
  // Until the replay its reads go to the real server; in the replay, to the answers recorded after the same write.
  let answers: Map<string, Recorded> | undefined;
  const earlier = new Map<string, Recorded>();
  let misses = 0;
  const measured = await DomPage.open(hooks, board, {
    stream: "manual",
    fetch: async (url, init) => {
      const hit = (init?.method ?? "GET") === "GET" && answers ? answers.get(key(url)) ?? earlier.get(key(url)) : undefined;
      if (!hit) { if (answers) misses++; return fetch(url, init); }
      return new Response(hit.body.slice(), { status: hit.status, headers: hit.headers });
    },
  });
  // The page that records: connected to the real server, as the owner's page is.
  let recording = new Map<string, Recorded>();
  const recorder = await DomPage.open(hooks, board, {
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if ((init?.method ?? "GET") === "GET" && response.ok) recording.set(key(url), { status: response.status, headers: [...response.headers.entries()], body: new Uint8Array(await response.clone().arrayBuffer()) });
      return response;
    },
  });
  const tap = new EventTap(board.url);
  await tap.ready;
  const s0 = board.store.snapshot(), r0 = rules(s0), rnd = prng(2105);
  const open = Object.keys(s0.items).filter(id => !s0.items[id]!.record && !/^(done|cancelled)$/.test(r0.statusOf(id) ?? ""));
  const vocabulary = (group: string) => (s0.board.tags ?? []).filter(t => !t.projects || t.projects.includes(group)).map(t => t.name);
  type Kind = "set_tags" | "log";
  const recorded: Array<{ kind: Kind; event: string; answers: Map<string, Recorded> }> = [];
  const plan: Kind[] = [...Array(WARMUP + WRITES).fill("set_tags"), ...Array(WARMUP + WRITES).fill("log")];
  let t0 = performance.now();
  for (const kind of plan) {
    const id = rnd.pick(open.filter(id => kind === "log" || vocabulary(s0.items[id]!.group).length >= 2)), item = board.store.snapshot().items[id]!;
    recording = new Map();
    if (kind === "set_tags") {
      // One tag the item does not hold alone yet, so every write changes it.
      const tag = vocabulary(item.group).find(name => !(item.tags?.length === 1 && item.tags[0] === name))!;
      await board.ops.setTags({ author: item.group, id, tags: [tag] });
    } else {
      const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      await rewrite<Item>(board.store, "item", id, doc => ({ ...doc, log: [...doc.log, { at, by: doc.group, text: "持续写入。" }], updated: at }), item.group);
    }
    const event = await tap.next();
    await recorder.waitChanges(recorded.length + 1);
    recorded.push({ kind, event, answers: recording });
  }
  tap.close(); recorder.close();
  console.log(`bench-page: recorded ${recorded.length} writes in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  const busy: Record<Kind, number[]> = { set_tags: [], log: [] }, wall: Record<Kind, number[]> = { set_tags: [], log: [] };
  let profile: Awaited<ReturnType<typeof profiled>> | undefined;
  for (const [k, w] of recorded.entries()) {
    answers = w.answers;
    const counted = (k % (WARMUP + WRITES)) >= WARMUP;
    if (args.profile && w.kind === "set_tags" && counted && !profile) profile = await profiled();
    if (args.profile && w.kind === "log" && profile) { console.log(await profile.stop(WRITES, "set_tags event")); profile = undefined; }
    const before = performance.eventLoopUtilization();
    t0 = performance.now();
    measured.deliver("change", w.event);
    await measured.settle();
    const used = performance.eventLoopUtilization(before);
    if (counted) { busy[w.kind].push(used.active); wall[w.kind].push(performance.now() - t0); }
    for (const [path, answer] of w.answers) earlier.set(path, answer);
  }
  if (profile) console.log(await profile.stop(WRITES, "set_tags event"));
  if (measured.errors.length) throw new Error("the measured page reported errors:\n" + measured.errors.join("\n"));
  const stats = (list: number[]) => {
    const sorted = [...list].sort((a, b) => a - b), at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    return { mean: +(list.reduce((a, b) => a + b, 0) / list.length).toFixed(1), median: +at(0.5).toFixed(1), p90: +at(0.9).toFixed(1), max: +at(1).toFixed(1) };
  };
  const result = {
    writes: WRITES, misses,
    setTags: { busyMs: stats(busy.set_tags), wallMs: stats(wall.set_tags) },
    log: { busyMs: stats(busy.log), wallMs: stats(wall.log) },
    eventBytes: { set_tags: Math.round(recorded.filter(w => w.kind === "set_tags").reduce((n, w) => n + w.event.length, 0) / (WARMUP + WRITES)), log: Math.round(recorded.filter(w => w.kind === "log").reduce((n, w) => n + w.event.length, 0) / (WARMUP + WRITES)) },
    // The page asks with the version it holds (`/api/unread?since=`), so the last answer is what changed, not the whole list.
    unreadBytes: recorded.flatMap(w => [...w.answers].filter(([path]) => path.startsWith("/api/unread")).map(([, answer]) => answer.body.length)).at(-1),
  };
  console.log(`  set_tags event: busy ms ${JSON.stringify(result.setTags.busyMs)}, wall ms ${JSON.stringify(result.setTags.wallMs)}`);
  console.log(`  log event:      busy ms ${JSON.stringify(result.log.busyMs)}, wall ms ${JSON.stringify(result.log.wallMs)}`);
  console.log(`  reads with no recorded answer: ${misses}; last unread answer ${result.unreadBytes} bytes`);
  console.log(`BENCH-PAGE ${JSON.stringify(result)}`);
} finally {
  for (const fn of cleanups.reverse()) await fn();
}
