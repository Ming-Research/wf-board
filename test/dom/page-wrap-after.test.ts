// The owner's page lands every click on what it claims: n and the arrows wrapping around the list, and the rows the tree draws, after writes (test/dom/page-families.ts).

import { pageTests } from "./page-families.ts";

pageTests("the owner's page lands every click on what it claims: n and the arrows wrapping around the list, and the rows the tree draws, after writes", ["wrap", "rows"], { passes: ["after"] });
