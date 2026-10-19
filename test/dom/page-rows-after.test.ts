// The owner's page lands every click on what it claims: the rows the tree draws, after writes (test/dom/page-families.ts); n and the
// arrows wrapping around the list after writes are test/dom/page-wrap-after.test.ts.

import { pageTests } from "./page-families.ts";

pageTests("the owner's page lands every click on what it claims: the rows the tree draws, after writes", ["rows"], { passes: ["after"] });
