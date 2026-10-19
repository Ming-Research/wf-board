// The owner's page lands every click on what it claims: n and the arrows wrapping around the list, after writes (test/dom/page-families.ts);
// the rows the tree draws after writes are test/dom/page-rows-after.test.ts.

import { pageTests } from "./page-families.ts";

pageTests("the owner's page lands every click on what it claims: n and the arrows wrapping around the list, after writes", ["wrap"], { passes: ["after"] });
