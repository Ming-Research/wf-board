// Where n and its reverse go next among the new-content stops, as plain functions of the stops so tests can check them
// without a page.

/** Orders two page positions: page row, card rank, comment flag, then commit order for what the page does not place. */
export function compareAt(a: number[], b: number[]): number { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; }

/** The stops sorted by position, indexed once per data change: each key's place, and the first stop after or last stop
 * before a position, found by binary search instead of a pass over every stop. */
export interface StopIndex {
  /** The place of each key's first stop: what findIndex(s => s.key === key) gives. */
  position: Map<string, number>;
  /** The first stop placed after `at`, or -1: what findIndex(s => compareAt(s.at, at) > 0) gives. */
  after(at: number[]): number;
  /** The last stop placed before `at`, or -1: what findLastIndex(s => compareAt(s.at, at) < 0) gives. */
  before(at: number[]): number;
}
export function stopIndex(stops: ReadonlyArray<{ key: string; at: number[] }>): StopIndex {
  const position = new Map<string, number>();
  stops.forEach((st, k) => { if (!position.has(st.key)) position.set(st.key, k); });
  // The first place whose stop compares above `at`, or also equal to it when `equal` is set.
  const bound = (at: number[], equal: boolean) => {
    let low = 0, high = stops.length;
    while (low < high) {
      const middle = (low + high) >> 1, c = compareAt(stops[middle]!.at, at);
      if (c > 0 || equal && c === 0) high = middle; else low = middle + 1;
    }
    return low;
  };
  return {
    position,
    after: at => { const k = bound(at, false); return k < stops.length ? k : -1; },
    before: at => bound(at, true) - 1,
  };
}
