// Reused rules against rules derived from nothing after random writes on a board of the live board's size (test/rules-reuse.ts),
// the writes of seed 20261018: part 3 of 3, which compares every third write from write 2; test/rules-reuse-a-1.test.ts and
// test/rules-reuse-a-2.test.ts compare the rest, the files of the other letters are other seeds, and test/rules-reuse-guards.test.ts
// takes each guard out.

import { reuseTests } from "./rules-reuse.ts";

reuseTests(20261018, 2, 3);
