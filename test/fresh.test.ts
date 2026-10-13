import { test } from "node:test";
import assert from "node:assert/strict";
import { compareAt, stopIndex } from "../web/fresh.ts";

// Deterministic positions shaped like the page's [row, card rank, comment flag, commit order]: few distinct values, so
// many stops tie, and some rows unplaced (the largest safe integer) and ordered by commit instead.
function positions(seed: number, count: number): number[][] {
  let x = seed;
  const next = (m: number) => { x = x * 48271 % 2147483647; return x % m; };
  return Array.from({ length: count }, () => {
    const placed = next(4) > 0;
    return [placed ? next(6) : Number.MAX_SAFE_INTEGER, next(3), next(2), placed ? 0 : next(5)];
  });
}

test("n's index finds the same stop as a search through every stop, ties and both ends included", () => {
  for (let seed = 1; seed <= 40; seed++) for (const count of [0, 1, 2, 7, 30]) {
    const stops = positions(seed, count).map((at, k) => ({ key: "k" + k, at })).sort((a, b) => compareAt(a.at, b.at));
    const index = stopIndex(stops);
    // Each stop's own position (equal to it and to its ties), other positions between them, and both ends.
    for (const at of [...stops.map(st => st.at), ...positions(seed + 1000, 20), [-1, 0, 0, 0], [Number.MAX_SAFE_INTEGER, 9, 9, 9]]) {
      assert.equal(index.after(at), stops.findIndex(st => compareAt(st.at, at) > 0), `next after ${at} (seed ${seed}, ${count} stops)`);
      assert.equal(index.before(at), stops.findLastIndex(st => compareAt(st.at, at) < 0), `previous before ${at} (seed ${seed}, ${count} stops)`);
    }
    for (const [k, st] of stops.entries()) assert.equal(index.position.get(st.key), k);
    assert.equal(index.position.get("missing"), undefined);
  }
  // A key listed twice keeps its first place, as findIndex finds it.
  const twice = stopIndex([{ key: "x", at: [0, 0, 0, 0] }, { key: "x", at: [1, 0, 0, 0] }]);
  assert.equal(twice.position.get("x"), 0);
});
