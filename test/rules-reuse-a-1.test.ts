// Reused rules against rules derived from nothing after random writes on a board of the live board's size (test/rules-reuse.ts),
// the writes of seed 20261018: part 1 of 2, which compares every other write (the even ones); test/rules-reuse-a-2.test.ts compares
// the rest, the files of the other letters are other seeds, and test/rules-reuse-guards.test.ts takes each guard out.

import { reuseTests } from "./rules-reuse.ts";

reuseTests(20261018, 0, 2);
