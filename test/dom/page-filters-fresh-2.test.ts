// The owner's page lands every click on what it claims: project filters on a fresh page, the second part of the projects (test/dom/page-families.ts).

import { pageTests } from "./page-families.ts";

pageTests("the owner's page lands every click on what it claims: project filters on a fresh page, the second part of the projects", ["filters"], { passes: ["fresh"], projects: { part: 1, of: 2 } });
