// The owner's page lands every click on what it claims: project filters on a fresh page (test/dom/page-families.ts).

import { pageTests } from "./page-families.ts";

pageTests("the owner's page lands every click on what it claims: project filters on a fresh page", ["filters"], { passes: ["fresh"] });
