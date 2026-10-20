// The owner's page lands every click on what it claims: project filters on a fresh page, the first part of the projects (test/dom/page-families.ts).

import { pageTests } from "./page-families.ts";

pageTests("the owner's page lands every click on what it claims: project filters on a fresh page, the first part of the projects", ["filters"], { passes: ["fresh"], projects: { part: 0, of: 2 } });
