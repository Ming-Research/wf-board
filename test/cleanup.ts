/** What a test does when it ends, last registered first: the hooks of `t.after` run in the order they were registered, so a
 * directory removed by the hook that made it goes before the server over it is closed, and what the server still reads (the
 * architect's timed wake, a request that is running) finds the repository gone. A function given here runs before every one
 * registered before it; all run even when one fails. A test of the order is test/teardown.test.ts. */
const stacks = new WeakMap<object, Array<() => unknown>>();

export function cleanup(t: { after(fn: () => unknown): void }, fn: () => unknown): void {
  let stack = stacks.get(t);
  if (!stack) {
    const own: Array<() => unknown> = stack = [];
    stacks.set(t, own);
    t.after(async () => {
      const errors: unknown[] = [];
      for (const run of own.reverse()) {
        try { await run(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "more than one cleanup failed");
    });
  }
  stack.push(fn);
}
