// The owner's page lands every click on what it claims: n and the arrows wrapping around the list, and the rows the tree draws, on a fresh page (test/dom/page-families.ts).

import { pageTests } from "./page-families.ts";

pageTests("the owner's page lands every click on what it claims: n and the arrows wrapping around the list, and the rows the tree draws, on a fresh page", ["wrap", "rows"], { passes: ["fresh"] });
