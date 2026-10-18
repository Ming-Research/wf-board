// Temporary probe for page-write-rest (not for merge): where the page's main thread goes for one write while sessions write 3 a second
// on a board of the live board's weight, by function name, with the callees of the draw's parts. Run by tmp-page-write-rest.yml.

import { test } from "node:test";
import type { CDPSession } from "playwright";
import { launch, BoardPage } from "./harness.ts";
import { prng } from "./board-gen.ts";
import { startLiveBoard } from "./live-board.ts";
import type { BoardServer } from "./harness.ts";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const out = (line: string) => console.log(line);

const INIT = `(() => {
  const p = window.__probe = { draws: [], rules: [], full: [], counts: [] };
  const mark0 = performance.mark.bind(performance);
  performance.mark = (name, opts) => {
    if (name === "board:render") p.draws.push(opts && opts.detail);
    else if (name === "board:rules") p.rules.push(1);
    else if (name === "board:rules-full") p.full.push(opts && opts.detail);
    else if (name === "board:filter-counts") p.counts.push(1);
    return mark0(name, opts);
  };
  const every = window.setInterval.bind(window);
  window.setInterval = (fn, delay, ...rest) => delay >= 30000 ? 0 : every(fn, delay, ...rest);
  window.__takeProbe = () => { const s = JSON.parse(JSON.stringify(p)); p.draws = []; p.rules = []; p.full = []; p.counts = []; return s; };
})();`;

function startWriters(board: BoardServer, perSecond: number) {
  const rnd = prng(777);
  let stopped = false, count = 0;
  const ids = Object.keys(board.store.snapshot().items).filter(id => !board.store.snapshot().items[id]!.record);
  const loop = (async () => {
    while (!stopped) {
      const id = rnd.pick(ids), it = board.store.snapshot().items[id]!, { rev, ...doc } = it, at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      try { await board.store.commit({ author: it.group, message: "writer", puts: [{ kind: "item", id, expectRev: rev, doc: { ...doc, log: [...it.log, { at, by: it.group, text: "持续写入。" }], updated: at } }] }); count++; } catch { /* lost race */ }
      await sleep(1000 / perSecond);
    }
  })();
  return { stop: async () => { stopped = true; await loop; return count; } };
}

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface CpuProfile { nodes: Node[]; samples: number[]; timeDeltas: number[] }

const PARENTS = ["renderPage", "presentationScopes", "signPresentation", "renderHeader", "countBelow", "stopsNow", "waitPanel", "freshStopsNow", "freshStops", "allFreshIndex", "freshIndex", "passes", "visible",
  "itemNode", "renderAreasDOM", "projectGroups", "applySnapshot", "invalidate", "affectedItems", "changeSeeds", "filterRow", "agentRowsNow", "renderAgents", "renderWhole", "renderMessages", "renderMenu", "renderSend", "index", "dataIndex", "tops", "cached", "dataCached"];

function summarize(profile: CpuProfile, writes: number) {
  const byId = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const name = (n: Node) => n.callFrame.functionName || "(anonymous)";
  const stacks = new Map<number, number[]>();
  const stackOf = (id: number): number[] => { let s = stacks.get(id); if (s) return s; const p = parent.get(id); s = [...(p === undefined ? [] : stackOf(p)), id]; stacks.set(id, s); return s; };
  const incl = new Map<string, number>(), self = new Map<string, number>(), child = new Map<string, Map<string, number>>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000, st = stackOf(id).map(k => name(byId.get(k)!));
    if (st[st.length - 1]!.startsWith("(idle)") || st[st.length - 1]!.startsWith("(program)")) return;
    total += dt;
    self.set(st[st.length - 1]!, (self.get(st[st.length - 1]!) ?? 0) + dt);
    for (const k of new Set(st)) incl.set(k, (incl.get(k) ?? 0) + dt);
    // The callee of each parent of interest, by name: the frame just below the first occurrence of the parent on the stack.
    for (const par of PARENTS) {
      const at = st.indexOf(par);
      if (at < 0 || at + 1 >= st.length) continue;
      const m = child.get(par) ?? new Map<string, number>(); child.set(par, m);
      m.set(st[at + 1]!, (m.get(st[at + 1]!) ?? 0) + dt);
    }
  });
  const per = (v: number) => (v / writes).toFixed(2).padStart(7);
  out(`PROFILE ${writes} writes, ${per(total)} ms/write sampled outside idle`);
  out("-- inclusive by name");
  for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 90)) out(`${per(v)} ms/write  ${k}`);
  out("-- self by name");
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) out(`${per(v)} ms/write  ${k}`);
  out("-- callees");
  for (const par of PARENTS) {
    const m = child.get(par); if (!m) continue;
    out(`${par} (${per(incl.get(par) ?? 0).trim()}):` + [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ` ${k} ${(v / writes).toFixed(2)}`).join(","));
  }
}

async function quiet(bp: BoardPage) { await bp.settle(); await sleep(120); await bp.settle(); }

test("probe: the page's profile for one write", { timeout: 40 * 60_000 }, async t => {
  const board = await startLiveBoard(t), browser = await launch(t);
  const bp = await BoardPage.open(browser, board, {}, INIT);
  const cdp: CDPSession = await bp.context.newCDPSession(bp.page);
  await bp.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  const warm = startWriters(board, 3); await sleep(3000); await warm.stop(); await quiet(bp);
  await bp.page.evaluate(() => (window as unknown as { __takeProbe(): unknown }).__takeProbe());
  await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  const c0 = await bp.changes();
  await cdp.send("Profiler.start");
  const w = startWriters(board, 3); await sleep(Number(process.env.PROBE_SECONDS ?? 30) * 1000); await w.stop(); await quiet(bp);
  const { profile } = await cdp.send("Profiler.stop") as { profile: CpuProfile };
  const writes = await bp.changes() - c0;
  const probe = await bp.page.evaluate(() => (window as unknown as { __takeProbe(): { draws: string[]; rules: number[]; full: string[]; counts: number[] } }).__takeProbe());
  out(`PROBE ${writes} writes: ${probe.draws.length} draws (${(probe.draws.length / writes).toFixed(2)}/write), ${probe.rules.length} rules builds, ${probe.full.length} from scratch, ${probe.counts.length} full filter counts`);
  const kinds = new Map<string, number>();
  for (const d of probe.draws) kinds.set(d ?? "", (kinds.get(d ?? "") ?? 0) + 1);
  out("draw scopes: " + [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${v}x[${k.length > 80 ? k.slice(0, 80) + "…" : k}]`).join(" "));
  summarize(profile, writes);
  await bp.context.close();
});
