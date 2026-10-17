// TEMPORARY (item patrol-changes, removed before the PR is ready): what an old board's check flags cost to work out, on a
// generated board of the live one's size. Run in CI by .github/workflows/tmp-patrol-cost.yml.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import { generateBoard } from "../test/e2e/board-gen.ts";
import { seedBoard } from "../test/e2e/seed.ts";
import { rules } from "../src/rules.ts";
import type { Snapshot } from "../src/model.ts";

const gc = () => { (globalThis as { gc?: () => void }).gc?.(); (globalThis as { gc?: () => void }).gc?.(); };
const heap = () => v8.getHeapStatistics().used_heap_size / 1048576;
const dir = await mkdtemp(join(tmpdir(), "wf-board-cost-"));
const gen = generateBoard(1, Number(process.env.SCALE ?? 10));
const { store } = await seedBoard(dir, gen);
const s = store.snapshot();
const ids = Object.keys(s.items);
console.log(`board: ${ids.length} items, ${Object.keys(s.decisions).length} cards, ${Object.keys(s.notes).length} notes`);

/** All checks of all items, as (item, label|text) keys, and the time and heap that took. */
function flags(snapshot: Snapshot, label: string): Set<string> {
  gc();
  const before = heap(), t0 = performance.now();
  const r = rules(snapshot);
  const out = new Set<string>();
  for (const id of Object.keys(snapshot.items)) for (const c of r.checks(id)) out.add(`${id}\u0000${c.label ?? c.text}`);
  const ms = performance.now() - t0, after = heap();
  console.log(`${label}: ${ms.toFixed(0)} ms, ${out.size} flags, heap +${(after - before).toFixed(0)} MB while the rules are alive`);
  return out;
}

/** The board as it was before a range of `n` changed documents: those items put back to an earlier version, some created in the range gone. */
function patched(n: number): Snapshot {
  const items = { ...s.items };
  const changed = ids.slice(0, n);
  for (const id of changed) items[id] = { ...items[id]!, title: items[id]!.title + " earlier" };
  for (const id of ids.slice(-5)) delete items[id];
  return { ...s, items };
}

for (let round = 1; round <= 3; round++) {
  console.log(`round ${round}`);
  const now = flags(s, "head board");
  for (const n of [10, 60, 300]) {
    const old = patched(n);
    const t0 = performance.now();
    const then = flags(old, `old board (${n} changed documents)`);
    const t1 = performance.now();
    const fresh = [...now].filter(f => !then.has(f));
    console.log(`  new flags ${fresh.length}; patch + both sides + difference ${(performance.now() - t0).toFixed(0)} ms (difference ${(performance.now() - t1).toFixed(1)} ms)`);
  }
}
await rm(dir, { recursive: true, force: true });
