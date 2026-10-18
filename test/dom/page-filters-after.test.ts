// The owner's page lands every click on what it claims: project filters on a page kept open while writes land (test/dom/page-families.ts).

import { pageTests } from "./page-families.ts";

pageTests("the owner's page lands every click on what it claims: project filters on a page kept open while writes land", ["filters"], { passes: ["after"] });
