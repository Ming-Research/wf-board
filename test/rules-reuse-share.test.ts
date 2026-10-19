// The parts of a seed (`reuseTests`, test/rules-reuse.ts) together compare what one run that compares every write compares: a guard
// of the reuse taken out of a copy of src/rules.ts is found by the parts, each in the writes it is dealt, and by nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checksOnly, liveSized, run, variant } from "./rules-reuse.ts";

test("the parts of a seed find together the mismatches one comparison of every write finds, each in its own writes", async t => {
  const board = liveSized(), writes = 60;
  // Without the item's owners in the reach of a write, a reused Rules object keeps the stalled counts of owners it should have recounted.
  const broken = await variant(t, [["      up(id);\n", ""]]);
  const whole = run(broken, board, 20261018, writes, checksOnly).mismatches;
  const parts = [0, 1, 2].map(part => run(broken, board, 20261018, writes, checksOnly, false, { part, of: 3 }));
  assert.ok(whole.length >= 3, `the comparison of every write finds the missing guard (${whole.length} mismatches)`);
  assert.deepEqual(parts.flatMap(p => p.mismatches).sort(), [...whole].sort(), "the parts find exactly the mismatches of the whole");
  parts.forEach((p, part) => {
    assert.ok(p.mismatches.every(what => Number(/^write (\d+):/.exec(what)![1]) % 3 === part), `part ${part + 1} reports only its own writes`);
    assert.equal(p.compared, Math.ceil((writes - part) / 3), `part ${part + 1} compared its share`);
  });
  assert.ok(parts.some(p => p.mismatches.length > 0) && parts.every(p => p.compared > 0));
});
