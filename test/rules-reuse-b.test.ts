// Reused rules against rules derived from nothing after random writes on a board of the live board's size (test/rules-reuse.ts),
// the writes of seed 20261019; test/rules-reuse-b.test.ts and test/rules-reuse-c.test.ts make others, test/rules-reuse-guards.test.ts
// takes each guard out.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as current from "../src/rules.ts";
import { answers, liveSized, run } from "./rules-reuse.ts";

test("reused rules answer what rules derived from nothing answer, after every write on a board of the live board's size (seed 20261019)", { timeout: 10 * 60_000 }, () => {
  const board = liveSized();
  assert.ok(Object.keys(board.s.items).length >= 1500, "the board has about 1,600 items");
  const { reasons, kinds, mismatches, stalledAtStart, waitingOnPaused } = run(current, board, 20261019, 100, answers);
  console.log(`rules reuse: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(", ")}; writes ${[...kinds].map(([k, v]) => `${k} ${v}`).join(", ")}; ${stalledAtStart} stalled at the start, ${waitingOnPaused} waiting on paused work`);
  assert.deepEqual(mismatches, [], "every Rules object answers what a derivation from nothing answers");
  // The premises of the comparison: most writes reused, the rest refused for the reasons the sequence makes, and the
  // states the guards protect were there.
  assert.ok((reasons.get("reused") ?? 0) > 50, "most writes reused the previous Rules object");
  assert.ok((reasons.get("document") ?? 0) > 2 && (reasons.get("minute") ?? 0) > 1, "plan writes and new minutes built from nothing");
  assert.ok(stalledAtStart >= 30 && waitingOnPaused > 0, "stalled items and items waiting on paused work were there to be changed");
});
