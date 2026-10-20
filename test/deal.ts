// The top-level tests of one module dealt out over several test files, so that a file too long for a shard runs as parts
// (docs/design.md, section 11, Sharding the script tests). The module calls `test` from here instead of node:test; a part file
// says which part it is with `dealOut` and then imports the module, which registers the tests at positions k with
// k % of === part only. The tests of such a module must not depend on one another.
import { test as nodeTest } from "node:test";

let share = { part: 0, of: 1 }, position = 0;

/** This process's part (from 0) of `of`; call it before the module is imported. */
export function dealOut(part: number, of: number): void { share = { part, of }; }

export const test = ((...args: Parameters<typeof nodeTest>) => (position++ % share.of === share.part ? nodeTest(...args) : Promise.resolve())) as typeof nodeTest;
