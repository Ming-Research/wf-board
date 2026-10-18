// The project filters of the owner's page show the right items, and its small checks of rows, chips and comments hold
// (test/dom/page-families.ts).

import { pageTests } from "./page-families.ts";

pageTests("the owner's page lands every click on what it claims: filters, chips and comments", ["filters"], true);
