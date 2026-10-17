/** Reads kept by key, oldest dropped first once they hold more than `limitBytes` (the sum of `weigh` over the settled
 * ones) or number more than `limitEntries` (pending reads count). A read that fails is not kept. An evicted read may still
 * finish, but cannot remove a newer retry. */
export class ReadCache<T> {
  private readonly entries = new Map<string, { promise: Promise<T>; weight: number }>();
  private held = 0;
  private readonly limitBytes: number;
  private readonly limitEntries: number;
  private readonly weigh: (value: T) => number;

  constructor(limitBytes: number, limitEntries: number, weigh: (value: T) => number) {
    this.limitBytes = limitBytes;
    this.limitEntries = limitEntries;
    this.weigh = weigh;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) return hit.promise;
    const entry = { promise: load(), weight: 0 };
    this.entries.set(key, entry);
    this.trim();
    entry.promise.then(value => {
      if (this.entries.get(key) !== entry) return;
      entry.weight = this.weigh(value);
      this.held += entry.weight;
      this.trim();
    }, () => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    return entry.promise;
  }

  private trim(): void {
    while (this.entries.size > this.limitEntries || this.held > this.limitBytes) {
      const [key, oldest] = this.entries.entries().next().value!;
      this.entries.delete(key);
      this.held -= oldest.weight;
    }
  }
}
